function parseOptions(relations) {
    const options = []
    for (const relation of relations) {
        for (const key in relation.option) {
            let foundOption = options.find((o) => o.name === key)
            if (!foundOption) {
                foundOption = {
                    name: key,
                    values: [],
                }
                options.push(foundOption)
            }
            foundOption.values.push(relation.option[foundOption.name].option_value)
        }
    }
    return options
}

console.log(
    parseOptions([
        {
            product_id: 2520,
            parent_id: 2519,
            image: '/d/s/dsc_4303_1.jpg',
            sku: 'OP70752WN',
            special_price: '49.9900',
            old_special_price: '49.9900',
            piid: '9227100',
            option: {
                color: {
                    option_id: 271,
                    option_value: 'Dark Red',
                },
            },
            instructions_pdf: 'https://cdn1.costway.com/PDF/instructions/05912478.pdf',
            price: {
                price: '49.99',
                special_from_date: '',
                special_to_date: '',
                special_price: '49.99',
                final_price: '49.99',
            },
            images: {
                image: 'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/d/s/dsc_4303_1.jpg',
                small_image:
                    'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/1/_/1_726_20.jpg',
            },
        },
        {
            product_id: 13365,
            parent_id: 2519,
            image: '/o/OP70752BL/10_Feet_Outdoor_Patio_Umbrella_Blue-4.jpg',
            sku: 'OP70752BL',
            special_price: '49.9900',
            old_special_price: '49.9900',
            piid: '9210100',
            option: {
                color: {
                    option_id: 101,
                    option_value: 'Blue',
                },
            },
            instructions_pdf: 'https://cdn1.costway.com/PDF/instructions/05912478.pdf',
            price: {
                price: '59.99',
                special_from_date: '',
                special_to_date: '',
                special_price: '49.99',
                final_price: '49.99',
            },
            images: {
                image: 'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/o/OP70752BL/10_Feet_Outdoor_Patio_Umbrella_Blue-4.jpg',
                small_image:
                    'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/o/OP70752BL/10_Feet_Outdoor_Patio_Umbrella_Blue-1.jpg',
            },
        },
        {
            product_id: 13368,
            parent_id: 2519,
            image: '/d/s/dsc_4303_3.jpg',
            sku: 'OP70752OR',
            special_price: '49.9900',
            old_special_price: '49.9900',
            piid: '9229000',
            option: {
                color: {
                    option_id: 290,
                    option_value: 'Orange',
                },
            },
            instructions_pdf: 'https://cdn1.costway.com/PDF/instructions/05912478.pdf',
            price: {
                price: '55.99',
                special_from_date: '',
                special_to_date: '',
                special_price: '49.99',
                final_price: '49.99',
            },
            images: {
                image: 'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/d/s/dsc_4303_3.jpg',
                small_image:
                    'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/1/_/1_726_22.jpg',
            },
        },
        {
            product_id: 319524,
            parent_id: 2519,
            image: '/1/0/10_Feet_Outdoor_Pati_1769577984272271_901503.jpg',
            sku: 'NP12259NY',
            special_price: '54.9900',
            old_special_price: '54.9900',
            piid: '9221000',
            option: {
                color: {
                    option_id: 21,
                    option_value: 'Navy',
                },
            },
            instructions_pdf: 'https://cdn1.costway.com/PDF/instructions/05912478.pdf',
            price: {
                price: '91.99',
                special_from_date: '',
                special_to_date: '',
                special_price: '54.99',
                final_price: '54.99',
            },
            images: {
                image: 'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/1/0/10_Feet_Outdoor_Pati_1769577984272271_901503.jpg',
                small_image:
                    'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/1/0/10_Feet_Outdoor_Pati_1769577983553937_515476.jpg',
            },
        },
        {
            product_id: 3201,
            parent_id: 2519,
            image: '/o/OP70752BE/10_Feet_Outdoor_Patio_Umbrella_with_Tilt_Adjustment_Beige-4.jpg',
            sku: 'OP70752BE',
            special_price: '59.9900',
            old_special_price: '59.9900',
            piid: '9229200',
            option: {
                color: {
                    option_id: 292,
                    option_value: 'Beige',
                },
            },
            instructions_pdf: 'https://cdn1.costway.com/PDF/instructions/05912478.pdf',
            price: {
                price: '64.99',
                special_from_date: '',
                special_to_date: '',
                special_price: '59.99',
                final_price: '59.99',
            },
            images: {
                image: 'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/o/OP70752BE/10_Feet_Outdoor_Patio_Umbrella_with_Tilt_Adjustment_Beige-4.jpg',
                small_image:
                    'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/o/OP70752BE/10_Feet_Outdoor_Patio_Umbrella_Beige-1.jpg',
            },
        },
        {
            product_id: 319407,
            parent_id: 2519,
            image: '/1/0/10_Feet_Outdoor_Pati_1769480989123598_167890.jpg',
            sku: 'NP12259HS',
            special_price: '59.9900',
            old_special_price: '59.9900',
            piid: '9224700',
            option: {
                color: {
                    option_id: 247,
                    option_value: 'Gray',
                },
            },
            instructions_pdf: 'https://cdn1.costway.com/PDF/instructions/05912478.pdf',
            price: {
                price: '91.99',
                special_from_date: '',
                special_to_date: '',
                special_price: '59.99',
                final_price: '59.99',
            },
            images: {
                image: 'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/1/0/10_Feet_Outdoor_Pati_1769480989123598_167890.jpg',
                small_image:
                    'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/1/0/10_Feet_Outdoor_Pati_1769480988403693_725834.jpg',
            },
        },
        {
            product_id: 2521,
            parent_id: 2519,
            image: '/n/p/np11523cf-1_2_.jpg',
            sku: 'OP70752CF',
            special_price: '69.9900',
            old_special_price: '69.9900',
            piid: '9252000',
            option: {
                color: {
                    option_id: 52,
                    option_value: 'Tan',
                },
            },
            instructions_pdf: 'https://cdn1.costway.com/PDF/instructions/05912478.pdf',
            price: {
                price: '69.99',
                special_from_date: '',
                special_to_date: '',
                special_price: '69.99',
                final_price: '69.99',
            },
            images: {
                image: 'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/n/p/np11523cf-1_2_.jpg',
                small_image:
                    'https://assets.costway.com/media/catalog/product/cache/0/thumbnail/360x/9df78eab33525d08d6e5fb8d27136e95/n/p/np11523cf-1_3_.jpg',
            },
        },
    ])
)
