const newProductId = 8187591655613
const oldProductId = 4613541101650

async function getShopifyProducts(cursor) {
    return fetch(`https://factorypure.myshopify.com/admin/api/2026-01/graphql.json`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': '',
        },
        body: JSON.stringify({
            query: `
                query ($cursor: String) {
                    products(first: 100, after: $cursor) {
                        edges {
                            cursor
                            node {
                                id
                                title
                                productType
                                crossSells: metafield(namespace: "custom", key: "cross_sells") {
                                    value
                                }
                            }
                        }
                        pageInfo {
                            hasNextPage
                        }
                    }
                }
            `,
            variables: { cursor },
        }),
    })
        .then((res) => res.json())
        .then((data) => data.data.products)
}

async function replaceGenpad3WithNewSku() {
    let cursor = null
    let hasNextPage = true
    let productCount = 0

    while (hasNextPage) {
        productCount += 100
        console.log(`Fetching products with cursor: ${cursor || 'null'} - product count so far: ${productCount}`)
        const products = await getShopifyProducts(cursor)

        for (const edge of products.edges) {
            const product = edge.node
            if (product.crossSells && product.crossSells.value.includes(oldProductId)) {
                const updatedCrossSells = product.crossSells.value.replace(oldProductId, newProductId)
                console.log(
                    `Updating product "${product.title}" (ID: ${product.id}) cross_sells from "${product.crossSells.value}" to "${updatedCrossSells}"`
                )

                // Update the product's cross_sells metafield
                await fetch(`https://factorypure.myshopify.com/admin/api/2026-01/graphql.json`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': '',
                    },
                    body: JSON.stringify({
                        query: `
                            mutation ($productId: ID!, $crossSellsValue: String!) {
                                metafieldsSet(metafields: [
                                    {
                                        ownerId: $productId,
                                        namespace: "custom",
                                        key: "cross_sells",
                                        type: "list.product_reference",
                                        value: $crossSellsValue
                                    }
                                ]) {
                                    metafields {
                                        id
                                        value
                                    }
                                    userErrors {
                                        field
                                        message
                                    }
                                }
                            }
                        `,
                        variables: {
                            productId: product.id,
                            crossSellsValue: updatedCrossSells,
                        },
                    }),
                })
                    .then((res) => res.json())
                    .then((data) => {
                        if (data.data.metafieldsSet.userErrors.length > 0) {
                            console.error(
                                `Error updating product "${product.title}" (ID: ${product.id}):`,
                                data.data.metafieldsSet.userErrors
                            )
                        } else {
                            console.log(
                                `Successfully updated product "${product.title}" (ID: ${product.id}) cross_sells to "${updatedCrossSells}"`
                            )
                        }
                    })
                    .catch((error) => {
                        console.error(`Error updating product "${product.title}" (ID: ${product.id}):`, error)
                    })
            }
        }

        hasNextPage = products.pageInfo.hasNextPage
        if (hasNextPage) {
            cursor = products.edges[products.edges.length - 1].cursor
        }
    }
    console.log('Finished processing all products.')
}
replaceGenpad3WithNewSku()
