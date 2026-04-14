class AlgoliaService {
    static containerName = "algolia"

    async search() {
        return {
            hits: [],
            nbHits: 0,
        }
    }
}

export default AlgoliaService