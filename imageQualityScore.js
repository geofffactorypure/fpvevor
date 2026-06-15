import sharp from 'sharp'
import path from 'path'

/**
 * Image quality scoring using Laplacian variance (sharpness detection)
 * and gradient energy. These metrics produce dramatic differences between
 * high-quality and low-quality images.
 *
 * Laplacian variance: measures edge/detail intensity via second derivative.
 *   High = sharp, detailed. Low = blurry, flat, over-compressed.
 *
 * Gradient energy: measures edge strength via first derivative (Sobel-like).
 *   High = strong edges/textures. Low = mushy/soft.
 */

async function calculateWhitespace(imagePath) {
    // Get raw RGBA data to check for transparency, fall back to white detection
    const image = sharp(imagePath)
    const metadata = await image.metadata()
    const hasAlpha = metadata.channels === 4

    const { data, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })

    const { width, height } = info
    const channels = 4 // ensureAlpha guarantees 4

    // Determine if pixel is "empty" (transparent or white)
    function isEmpty(x, y) {
        const offset = (y * width + x) * channels
        const r = data[offset]
        const g = data[offset + 1]
        const b = data[offset + 2]
        const a = data[offset + 3]

        if (hasAlpha) {
            return a < 10 // transparent
        }
        // No alpha channel — check if white (threshold 250)
        return r >= 250 && g >= 250 && b >= 250
    }

    // Find min distance from each edge to first non-empty pixel
    // Top edge
    let topDist = 0
    topSearch: for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!isEmpty(x, y)) break topSearch
        }
        topDist++
    }

    // Bottom edge
    let bottomDist = 0
    bottomSearch: for (let y = height - 1; y >= 0; y--) {
        for (let x = 0; x < width; x++) {
            if (!isEmpty(x, y)) break bottomSearch
        }
        bottomDist++
    }

    // Left edge
    let leftDist = 0
    leftSearch: for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            if (!isEmpty(x, y)) break leftSearch
        }
        leftDist++
    }

    // Right edge
    let rightDist = 0
    rightSearch: for (let x = width - 1; x >= 0; x--) {
        for (let y = 0; y < height; y++) {
            if (!isEmpty(x, y)) break rightSearch
        }
        rightDist++
    }

    const topPct = (topDist / height) * 100
    const bottomPct = (bottomDist / height) * 100
    const leftPct = (leftDist / width) * 100
    const rightPct = (rightDist / width) * 100
    const totalWhitespacePct = (((topDist + bottomDist) / height + (leftDist + rightDist) / width) / 2) * 100

    return {
        top: { px: topDist, pct: topPct },
        bottom: { px: bottomDist, pct: bottomPct },
        left: { px: leftDist, pct: leftPct },
        right: { px: rightDist, pct: rightPct },
        totalWhitespacePct,
        hasAlpha,
    }
}

async function calculateImageQualityScore(imagePath) {
    // Convert to grayscale for sharpness analysis
    const { data, info } = await sharp(imagePath).grayscale().raw().toBuffer({ resolveWithObject: true })

    const { width, height } = info

    console.log(`Image: ${path.basename(imagePath)}`)
    console.log(`Dimensions: ${width}x${height}`)

    // --- Laplacian Variance ---
    // Laplacian kernel: [0, 1, 0; 1, -4, 1; 0, 1, 0]
    // Compute for all interior pixels
    let lapSum = 0
    let lapSumSq = 0
    let lapCount = 0

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const center = data[y * width + x]
            const top = data[(y - 1) * width + x]
            const bottom = data[(y + 1) * width + x]
            const left = data[y * width + (x - 1)]
            const right = data[y * width + (x + 1)]

            const laplacian = top + bottom + left + right - 4 * center

            lapSum += laplacian
            lapSumSq += laplacian * laplacian
            lapCount++
        }
    }

    const lapMean = lapSum / lapCount
    const lapVariance = lapSumSq / lapCount - lapMean * lapMean

    // --- Gradient Energy (Sobel-like) ---
    // Simplified: horizontal and vertical differences
    let gradSum = 0
    let gradCount = 0

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const gx = data[y * width + (x + 1)] - data[y * width + (x - 1)]
            const gy = data[(y + 1) * width + x] - data[(y - 1) * width + x]
            gradSum += gx * gx + gy * gy
            gradCount++
        }
    }

    const gradEnergy = gradSum / gradCount

    // --- Percentage of flat regions (Laplacian near zero) ---
    let flatCount = 0
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const center = data[y * width + x]
            const top = data[(y - 1) * width + x]
            const bottom = data[(y + 1) * width + x]
            const left = data[y * width + (x - 1)]
            const right = data[y * width + (x + 1)]
            const laplacian = Math.abs(top + bottom + left + right - 4 * center)
            if (laplacian <= 2) flatCount++
        }
    }
    const flatPct = (flatCount / lapCount) * 100

    console.log(`\nResults:`)
    console.log(`  Laplacian variance: ${lapVariance.toFixed(1)} (higher = sharper/more detail)`)
    console.log(`  Gradient energy:    ${gradEnergy.toFixed(1)} (higher = stronger edges)`)
    console.log(`  Flat regions:       ${flatPct.toFixed(1)}% (lower = more texture)`)

    const quality = lapVariance < 50 ? 'LOW' : lapVariance < 200 ? 'MEDIUM' : 'HIGH'
    console.log(`  Quality estimate:   ${quality}`)

    // --- Whitespace / padding analysis ---
    const ws = await calculateWhitespace(imagePath)
    console.log(`\n  Whitespace (${ws.hasAlpha ? 'transparency' : 'white'} detection):`)
    console.log(`    Top:    ${ws.top.px}px (${ws.top.pct.toFixed(1)}%)`)
    console.log(`    Bottom: ${ws.bottom.px}px (${ws.bottom.pct.toFixed(1)}%)`)
    console.log(`    Left:   ${ws.left.px}px (${ws.left.pct.toFixed(1)}%)`)
    console.log(`    Right:  ${ws.right.px}px (${ws.right.pct.toFixed(1)}%)`)
    console.log(`    Total padding:  ${ws.totalWhitespacePct.toFixed(1)}%`)
    if (ws.totalWhitespacePct > 30) console.log(`    ⚠️  Excessive whitespace!`)

    return { lapVariance, gradEnergy, flatPct, whitespace: ws }
}

// CLI usage
const args = process.argv.slice(2)
if (args.length === 0) {
    console.log('Usage: node imageQualityScore.js <image1> [image2] ...')
    console.log('Example: node imageQualityScore.js good.jpg bad.jpg')
    process.exit(1)
}

console.log('=== Image Quality Scorer (Laplacian + Gradient) ===\n')

for (const imgPath of args) {
    console.log('─'.repeat(50))
    await calculateImageQualityScore(imgPath)
    console.log('')
}
