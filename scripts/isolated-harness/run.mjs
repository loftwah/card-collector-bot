#!/usr/bin/env node
// A self-reported digest or a network-none container is not a verified image,
// storage binding or artifact-serving proof. Keep execution unavailable until
// a managed runner provides and validates those properties independently.
console.error('Isolated harness held: clean image provenance, disposable bindings and served artifact integrity have not been verified.');
process.exit(2);
