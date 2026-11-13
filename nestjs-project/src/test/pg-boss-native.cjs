// Jest-only shim for the ESM-only `pg-boss` package (v12, `"type": "module"`).
//
// The application runs on Node >= 22.12, where CommonJS can `require()` an ESM
// package natively, so production code imports `pg-boss` directly. Jest,
// however, uses its own CommonJS module registry, which cannot evaluate ESM
// files from node_modules ("Cannot use import statement outside a module").
// `moduleNameMapper` points `pg-boss` here, and this file loads it through
// Node's native `require` (created with `createRequire`), outside Jest's
// registry. Types still come from the real package (TypeScript ignores this).
//
// `process.getBuiltinModule` (Node >= 22.3) is required: Jest substitutes its
// own `node:module`, whose `createRequire` re-enters Jest's registry, applies
// this same mapping again and returns this file's half-built exports.
'use strict';

const { createRequire } = process.getBuiltinModule('node:module');

module.exports = createRequire(__filename)('pg-boss');
