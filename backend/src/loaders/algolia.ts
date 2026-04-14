import { asClass } from "@medusajs/framework/awilix"
import AlgoliaService from "../services/algolia-service"

export default async ({ container }) => {
    container.register({
        algolia: asClass(AlgoliaService).singleton(),
    })
}