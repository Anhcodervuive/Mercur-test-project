import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, QueryContext } from "@medusajs/framework/utils"

type SearchBody = {
  query?: string
  page?: number
  hitsPerPage?: number
  filters?: string
  facets?: string[]
  maxValuesPerFacet?: number
  currency_code?: string
  region_id?: string
  customer_id?: string
  customer_group_id?: string[]
}

type ProductRecord = Record<string, any>

type ParsedFilters = {
  requireSeller: boolean
  excludeSuspendedSeller: boolean
  sellerHandle?: string
  supportedCountry?: string
  categoryId?: string
  collectionId?: string
  currencyCode?: string
  minPrice?: number
  maxPrice?: number
  greaterThanPrice?: number
  minRating?: number
  sizeValues: Set<string>
  colorValues: Set<string>
  conditionValues: Set<string>
}

const DEFAULT_FACETS = ["variants.condition", "variants.color", "variants.size"]

const cleanToken = (token?: string) => {
  if (!token) {
    return ""
  }

  const withoutSuffix = token.replace(/[)\s]+$/, "")
  const unquoted = withoutSuffix.replace(/^['"]|['"]$/g, "")

  try {
    return decodeURIComponent(unquoted)
  } catch {
    return unquoted
  }
}

const toComparable = (value: unknown) => String(value ?? "").trim().toLowerCase()

const addFacetValue = (map: Map<string, string>, value: unknown) => {
  const raw = String(value ?? "").trim()
  if (!raw) {
    return
  }

  const key = raw.toLowerCase()
  if (!map.has(key)) {
    map.set(key, raw)
  }
}

const getVariantDimensionValues = (
  product: ProductRecord,
  dimension: "size" | "color" | "condition"
) => {
  const values = new Map<string, string>()

  for (const variant of product?.variants ?? []) {
    addFacetValue(values, variant?.[dimension])

    for (const option of variant?.options ?? []) {
      const optionTitle = toComparable(option?.option?.title ?? option?.title)
      if (optionTitle === dimension) {
        addFacetValue(values, option?.value)
      }
    }
  }

  for (const attributeValue of product?.attribute_values ?? []) {
    const attributeName = toComparable(
      attributeValue?.attribute?.name ?? attributeValue?.name
    )

    if (attributeName === dimension) {
      addFacetValue(values, attributeValue?.value)
    }
  }

  return [...values.values()]
}

const getProductPrices = (product: ProductRecord, currencyCode?: string) => {
  const prices: number[] = []
  const compareCurrency = currencyCode ? currencyCode.toLowerCase() : undefined

  for (const variant of product?.variants ?? []) {
    for (const price of variant?.prices ?? []) {
      const priceCurrency = String(price?.currency_code ?? "").toLowerCase()
      if (compareCurrency && priceCurrency !== compareCurrency) {
        continue
      }

      const amount = Number(price?.amount)
      if (Number.isFinite(amount)) {
        prices.push(amount)
      }
    }

    const calculatedPrice = variant?.calculated_price
    if (calculatedPrice) {
      const calculatedCurrency = String(calculatedPrice?.currency_code ?? "").toLowerCase()
      if (compareCurrency && calculatedCurrency !== compareCurrency) {
        continue
      }

      const calculatedAmount = Number(
        calculatedPrice?.calculated_amount_with_tax ?? calculatedPrice?.calculated_amount
      )

      if (Number.isFinite(calculatedAmount)) {
        prices.push(calculatedAmount)
      }
    }
  }

  return prices
}

const parseFilterValues = (filters: string, regex: RegExp) => {
  const values = new Set<string>()
  let match = regex.exec(filters)

  while (match) {
    const value = cleanToken(match[1]).toLowerCase()
    if (value) {
      values.add(value)
    }

    match = regex.exec(filters)
  }

  return values
}

const parseFilters = (filters?: string): ParsedFilters => {
  const parsed: ParsedFilters = {
    requireSeller: false,
    excludeSuspendedSeller: false,
    sizeValues: new Set<string>(),
    colorValues: new Set<string>(),
    conditionValues: new Set<string>(),
  }

  if (!filters) {
    return parsed
  }

  parsed.requireSeller = /NOT\s+seller:null/i.test(filters)
  parsed.excludeSuspendedSeller = /NOT\s+seller\.store_status:SUSPENDED/i.test(filters)

  parsed.sellerHandle = cleanToken(filters.match(/seller\.handle:([^\s]+)/i)?.[1])
  parsed.supportedCountry = cleanToken(filters.match(/supported_countries:([^\s]+)/i)?.[1])
  parsed.categoryId = cleanToken(filters.match(/categories\.id:([^\s]+)/i)?.[1])
  parsed.collectionId = cleanToken(filters.match(/collections?\.id:([^\s]+)/i)?.[1])
  parsed.currencyCode = cleanToken(filters.match(/variants\.prices\.currency_code:([^\s]+)/i)?.[1])

  const priceRangeMatch = filters.match(
    /variants\.prices\.amount:([0-9]+(?:\.[0-9]+)?)\s+TO\s+([0-9]+(?:\.[0-9]+)?)/i
  )

  if (priceRangeMatch) {
    parsed.minPrice = Number(priceRangeMatch[1])
    parsed.maxPrice = Number(priceRangeMatch[2])
  }

  const minPriceMatch = filters.match(/variants\.prices\.amount\s*>=\s*([0-9]+(?:\.[0-9]+)?)/i)
  if (minPriceMatch) {
    parsed.minPrice = Number(minPriceMatch[1])
  }

  const maxPriceMatch = filters.match(/variants\.prices\.amount\s*<=\s*([0-9]+(?:\.[0-9]+)?)/i)
  if (maxPriceMatch) {
    parsed.maxPrice = Number(maxPriceMatch[1])
  }

  const greaterThanPriceMatch = filters.match(/variants\.prices\.amount\s*>\s*([0-9]+(?:\.[0-9]+)?)/i)
  if (greaterThanPriceMatch) {
    parsed.greaterThanPrice = Number(greaterThanPriceMatch[1])
  }

  const ratingValues = parseFilterValues(filters, /average_rating\s*>=\s*([0-9]+(?:\.[0-9]+)?)/gi)
  if (ratingValues.size > 0) {
    parsed.minRating = Math.min(...[...ratingValues].map((v) => Number(v)))
  }

  parsed.sizeValues = parseFilterValues(filters, /variants\.size:\"([^\"]+)\"/gi)
  parsed.colorValues = parseFilterValues(filters, /variants\.color:\"([^\"]+)\"/gi)
  parsed.conditionValues = parseFilterValues(filters, /variants\.condition:\"([^\"]+)\"/gi)

  return parsed
}

const hasIntersectingValues = (values: string[], requiredValues: Set<string>) => {
  if (!requiredValues.size) {
    return true
  }

  return values.some((value) => requiredValues.has(value.toLowerCase()))
}

const hasMatchingPrice = (product: ProductRecord, parsedFilters: ParsedFilters) => {
  const hasPriceConstraint =
    parsedFilters.currencyCode ||
    parsedFilters.greaterThanPrice !== undefined ||
    parsedFilters.minPrice !== undefined ||
    parsedFilters.maxPrice !== undefined

  if (!hasPriceConstraint) {
    return true
  }

  const prices = getProductPrices(product, parsedFilters.currencyCode)

  if (!prices.length) {
    return false
  }

  return prices.some((amount) => {
    if (parsedFilters.greaterThanPrice !== undefined && amount <= parsedFilters.greaterThanPrice) {
      return false
    }

    if (parsedFilters.minPrice !== undefined && amount < parsedFilters.minPrice) {
      return false
    }

    if (parsedFilters.maxPrice !== undefined && amount > parsedFilters.maxPrice) {
      return false
    }

    return true
  })
}

const matchesFilters = (product: ProductRecord, parsedFilters: ParsedFilters) => {
  if (parsedFilters.requireSeller && !product?.seller) {
    return false
  }

  if (
    parsedFilters.excludeSuspendedSeller &&
    toComparable(product?.seller?.store_status) === "suspended"
  ) {
    return false
  }

  if (
    parsedFilters.sellerHandle &&
    toComparable(product?.seller?.handle) !== parsedFilters.sellerHandle.toLowerCase()
  ) {
    return false
  }

  if (parsedFilters.supportedCountry) {
    const supportedCountries = (product?.supported_countries ?? [])
      .map((country: string) => String(country).toLowerCase())
      .filter(Boolean)

    if (
      Array.isArray(product?.supported_countries) &&
      supportedCountries.length > 0 &&
      !supportedCountries.includes(parsedFilters.supportedCountry.toLowerCase())
    ) {
      return false
    }
  }

  if (parsedFilters.categoryId) {
    const categoryMatches = (product?.categories ?? []).some(
      (category: ProductRecord) => String(category?.id) === parsedFilters.categoryId
    )

    if (!categoryMatches) {
      return false
    }
  }

  if (parsedFilters.collectionId) {
    const collectionId = String(product?.collection?.id ?? product?.collection_id ?? "")
    if (collectionId !== parsedFilters.collectionId) {
      return false
    }
  }

  if (!hasMatchingPrice(product, parsedFilters)) {
    return false
  }

  const sizes = getVariantDimensionValues(product, "size")
  const colors = getVariantDimensionValues(product, "color")
  const conditions = getVariantDimensionValues(product, "condition")

  if (!hasIntersectingValues(sizes, parsedFilters.sizeValues)) {
    return false
  }

  if (!hasIntersectingValues(colors, parsedFilters.colorValues)) {
    return false
  }

  if (!hasIntersectingValues(conditions, parsedFilters.conditionValues)) {
    return false
  }

  if (parsedFilters.minRating !== undefined) {
    const rating = Number(product?.average_rating ?? 0)
    if (!Number.isFinite(rating) || rating < parsedFilters.minRating) {
      return false
    }
  }

  return true
}

const buildSearchHaystack = (product: ProductRecord) => {
  const fields: string[] = [
    product?.title,
    product?.subtitle,
    product?.description,
    product?.handle,
    product?.seller?.name,
    product?.seller?.handle,
    ...(product?.tags ?? []).map((tag: ProductRecord) => tag?.value),
    ...(product?.categories ?? []).map((category: ProductRecord) => category?.name),
    ...(product?.variants ?? []).map((variant: ProductRecord) => variant?.title),
    ...(product?.attribute_values ?? []).flatMap((attr: ProductRecord) => [
      attr?.value,
      attr?.name,
      attr?.attribute?.name,
    ]),
  ]

  return fields.filter(Boolean).join(" ").toLowerCase()
}

const getSearchScore = (product: ProductRecord, query: string) => {
  const normalizedQuery = query.trim().toLowerCase()
  const haystack = buildSearchHaystack(product)
  const title = String(product?.title ?? "").toLowerCase()
  const handle = String(product?.handle ?? "").toLowerCase()

  let score = 0

  if (title === normalizedQuery) {
    score += 100
  } else if (title.startsWith(normalizedQuery)) {
    score += 60
  } else if (title.includes(normalizedQuery)) {
    score += 35
  }

  if (handle.includes(normalizedQuery)) {
    score += 25
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  for (const token of tokens) {
    if (title.includes(token)) {
      score += 12
    } else if (haystack.includes(token)) {
      score += 4
    }
  }

  return score
}

const matchesSearchQuery = (product: ProductRecord, query: string) => {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return true
  }

  const haystack = buildSearchHaystack(product)
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)

  return tokens.every((token) => haystack.includes(token))
}

const buildFacets = (products: ProductRecord[], requestedFacets: string[]) => {
  const facets: Record<string, Record<string, number>> = {}

  for (const facet of requestedFacets) {
    const counts: Record<string, number> = {}

    for (const product of products) {
      let values: string[] = []
      if (facet === "variants.size") {
        values = getVariantDimensionValues(product, "size")
      } else if (facet === "variants.color") {
        values = getVariantDimensionValues(product, "color")
      } else if (facet === "variants.condition") {
        values = getVariantDimensionValues(product, "condition")
      }

      const seen = new Set<string>()
      for (const value of values) {
        const key = String(value ?? "").trim()
        if (!key) {
          continue
        }

        const dedupeKey = key.toLowerCase()
        if (seen.has(dedupeKey)) {
          continue
        }

        seen.add(dedupeKey)
        counts[key] = (counts[key] ?? 0) + 1
      }
    }

    facets[facet] = counts
  }

  return facets
}

const buildFallbackCalculatedPrice = (variant: ProductRecord, currencyCode?: string) => {
  const prices = Array.isArray(variant?.prices) ? variant.prices : []
  const compareCurrency = currencyCode?.toLowerCase()

  const matchedPrice =
    prices.find(
      (price: ProductRecord) =>
        compareCurrency &&
        String(price?.currency_code ?? "").toLowerCase() === compareCurrency
    ) ?? prices[0]

  if (!matchedPrice) {
    return undefined
  }

  const amount = Number(matchedPrice?.amount)
  if (!Number.isFinite(amount)) {
    return undefined
  }

  return {
    currency_code: matchedPrice.currency_code,
    calculated_amount: amount,
    calculated_amount_with_tax: amount,
    calculated_amount_without_tax: amount,
    original_amount: amount,
    original_amount_with_tax: amount,
    calculated_price: {
      price_list_type: null,
    },
  }
}

const toResponseProduct = (product: ProductRecord, currencyCode?: string) => {
  return {
    id: product?.id,
    title: product?.title,
    handle: product?.handle,
    thumbnail: product?.thumbnail ?? product?.images?.[0]?.url ?? null,
    seller: product?.seller
      ? {
          id: product.seller.id,
          handle: product.seller.handle,
          name: product.seller.name,
          store_status: product.seller.store_status,
        }
      : null,
    variants: (product?.variants ?? []).map((variant: ProductRecord) => ({
      id: variant?.id,
      title: variant?.title,
      calculated_price:
        variant?.calculated_price ?? buildFallbackCalculatedPrice(variant, currencyCode),
    })),
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const startedAt = Date.now()

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const payload = ((req as any).validatedBody ?? req.body ?? {}) as SearchBody

  const searchQuery = String(payload?.query ?? "").trim()
  const page = Math.max(0, Number(payload?.page ?? 0) || 0)
  const hitsPerPage = Math.min(100, Math.max(1, Number(payload?.hitsPerPage ?? 12) || 12))
  const parsedFilters = parseFilters(payload?.filters)

  const currencyCode = payload?.currency_code || parsedFilters.currencyCode
  const regionId = payload?.region_id
  const customerId = payload?.customer_id
  const customerGroupIds = payload?.customer_group_id

  const hasPricingContext = Boolean(currencyCode)

  const contextParams: Record<string, any> = {}
  if (hasPricingContext) {
    contextParams.variants = {
      calculated_price: QueryContext({
        ...(currencyCode && { currency_code: currencyCode }),
        ...(regionId && { region_id: regionId }),
        ...(customerId && { customer_id: customerId }),
        ...(customerGroupIds?.length && { customer_group_id: customerGroupIds }),
      }),
    }
  }

  const { data: allProducts } = await query.graph({
    entity: "product",
    fields: [
      "*",
      "images.*",
      "options.*",
      "options.values.*",
      "variants.*",
      "variants.options.*",
      "variants.prices.*",
      ...(hasPricingContext ? ["variants.calculated_price.*"] : []),
      "categories.*",
      "collection.*",
      "type.*",
      "tags.*",
      "seller.*",
      "attribute_values.*",
      "attribute_values.attribute.*",
    ],
    filters: {
      status: "published",
    },
    ...(Object.keys(contextParams).length > 0 ? { context: contextParams } : {}),
  })

  let filteredProducts = allProducts.filter((product: ProductRecord) => {
    return matchesFilters(product, parsedFilters) && matchesSearchQuery(product, searchQuery)
  })

  if (
    filteredProducts.length === 0 &&
    parsedFilters.requireSeller &&
    !parsedFilters.sellerHandle
  ) {
    const hasAnySellerData = allProducts.some((product: ProductRecord) => Boolean(product?.seller))
    if (!hasAnySellerData) {
      const relaxedFilters: ParsedFilters = {
        ...parsedFilters,
        requireSeller: false,
      }
      filteredProducts = allProducts.filter((product: ProductRecord) => {
        return matchesFilters(product, relaxedFilters) && matchesSearchQuery(product, searchQuery)
      })
    }
  }

  filteredProducts = filteredProducts.sort((a: ProductRecord, b: ProductRecord) => {
    if (searchQuery) {
      const scoreA = getSearchScore(a, searchQuery)
      const scoreB = getSearchScore(b, searchQuery)

      if (scoreA !== scoreB) {
        return scoreB - scoreA
      }
    }

    const dateA = new Date(a?.updated_at ?? a?.created_at ?? 0).getTime() || 0
    const dateB = new Date(b?.updated_at ?? b?.created_at ?? 0).getTime() || 0
    return dateB - dateA
  })

  const requestedFacets =
    payload?.facets?.filter((facet) => DEFAULT_FACETS.includes(facet)) ?? DEFAULT_FACETS

  const facets = buildFacets(filteredProducts, requestedFacets.length ? requestedFacets : DEFAULT_FACETS)

  const nbHits = filteredProducts.length
  const nbPages = nbHits > 0 ? Math.ceil(nbHits / hitsPerPage) : 0

  const offset = page * hitsPerPage
  const pagedProducts = filteredProducts.slice(offset, offset + hitsPerPage)
  const responseProducts = pagedProducts.map((product: ProductRecord) =>
    toResponseProduct(product, currencyCode)
  )

  res.json({
    products: responseProducts,
    hits: responseProducts,
    nbHits,
    page,
    nbPages,
    hitsPerPage,
    facets,
    facets_stats: {},
    processingTimeMS: Date.now() - startedAt,
    query: searchQuery,
  })
}
