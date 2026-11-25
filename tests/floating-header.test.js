import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
test('UI-01: headers use the intended scroll container',()=>{
 assert.match(css,/html:has\(\.gm\),body:has\(\.gm\)\{overflow-x:clip/);
 assert.match(css,/\.gm-topbar\{position:sticky;top:0/);
 assert.match(css,/env\(safe-area-inset-top\)/);
 assert.match(readFileSync(new URL('../src/app.js',import.meta.url),'utf8'),/<div class="gm-topbar"><header>.*?<\/nav><\/div>/s);
});
