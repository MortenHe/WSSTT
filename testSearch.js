const fs = require('fs-extra');
const MiniSearch = require('minisearch');
const path = require('path');

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
    console.error('Usage: node testSearch.js <search phrase>');
    process.exit(1);
}

const indexFile = path.join(__dirname, 'sttIndex.json');
const data = fs.readJSONSync(indexFile);
const searchIndex = new MiniSearch({
    fields: ['search'],
    storeFields: ['name', 'lang', 'topMode', 'mode']
});

searchIndex.addAll(data);
const results = searchIndex.search(query, { prefix: true });

console.log(`Query: ${query}`);
console.log(`Results: ${results.length}`);
//console.log(JSON.stringify(results.slice(0, 5), null, 2));

const item = results[1];
console.log(`First result: ${item.name}, lang: ${item.lang}, topMode: ${item.topMode}, mode: ${item.mode}`);


