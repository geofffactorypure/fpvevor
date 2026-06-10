import fs from 'fs';

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let c = 0; c < line.length; c++) {
    if (line[c] === '"') {
      inQuotes = !inQuotes;
    } else if (line[c] === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += line[c];
    }
  }
  fields.push(current.trim());
  return fields;
}

// 1. Read ai_type_merge: Calculated Type, Status, Vevor Type
//    Build a map from Vevor Type -> { calculatedType, status }
const mergeLines = fs.readFileSync('vevor_ai_type_merge.csv', 'utf8').split('\n').filter(Boolean);
const vevorTypeMap = new Map(); // vevorType -> { calculatedType, status }

for (let i = 1; i < mergeLines.length; i++) {
  const fields = parseCsvLine(mergeLines[i]);
  const calculatedType = fields[0];
  const status = fields[1];
  const vevorType = fields[2];
  if (!vevorType || !calculatedType) continue;
  vevorTypeMap.set(vevorType, { calculatedType, status });
}
console.log(`Loaded ${vevorTypeMap.size} vevor type mappings from ai_type_merge`);

// 2. Read sku_type_mapping: SKU, Title, Vevor Product Type, Mapped Product Type
//    For each SKU, look up its Vevor Product Type in the merge map to get the new Calculated Type
const skuLines = fs.readFileSync('vevor_sku_type_mapping.csv', 'utf8').split('\n').filter(Boolean);
const typeCountMap = new Map(); // calculatedType -> { isNew, count }
const updatedSkuLines = [skuLines[0]]; // keep header
let matched = 0;
let unmatched = 0;

function escapeCsv(val) {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

for (let i = 1; i < skuLines.length; i++) {
  const fields = parseCsvLine(skuLines[i]);
  const vevorProductType = fields[2];
  if (!vevorProductType) {
    updatedSkuLines.push(skuLines[i]);
    continue;
  }

  const mapping = vevorTypeMap.get(vevorProductType);
  if (mapping) {
    matched++;
    const { calculatedType, status } = mapping;
    if (typeCountMap.has(calculatedType)) {
      typeCountMap.get(calculatedType).count++;
    } else {
      typeCountMap.set(calculatedType, { isNew: status === 'New', count: 1 });
    }
    // Update the Mapped Product Type (field 3) with the new calculated type
    fields[3] = calculatedType;
    updatedSkuLines.push(fields.map(escapeCsv).join(','));
  } else {
    unmatched++;
    updatedSkuLines.push(skuLines[i]);
  }
}
console.log(`SKUs matched: ${matched}, unmatched: ${unmatched}`);

// Write updated sku_type_mapping
fs.writeFileSync('vevor_sku_type_mapping.csv', updatedSkuLines.join('\n'));
console.log(`Updated vevor_sku_type_mapping.csv (${updatedSkuLines.length - 1} SKUs)`);

// 3. Output distinct types sorted alphabetically
const sorted = [...typeCountMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const csvLines = ['Type,New,Product Count'];
for (const [type, { isNew, count }] of sorted) {
  const escaped = (type.includes(',') || type.includes('"')) ? '"' + type.replace(/"/g, '""') + '"' : type;
  csvLines.push(escaped + ',' + (isNew ? 'Yes' : 'No') + ',' + count);
}
fs.writeFileSync('vevor_distinct_types.csv', csvLines.join('\n'));
console.log(`Written vevor_distinct_types.csv (${sorted.length} types)`);
