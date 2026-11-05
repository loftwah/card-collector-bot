#!/usr/bin/env node
// Read-only identity check; no owner data or credentials are printed.
import { inspectBundle } from './lib/release-artifact.mjs';
import { sourceState } from './lib/source-identity.mjs';
const source=sourceState();
const dirty=source.dirty.split('\n').filter(line=>line.trim() && !line.includes('docs/evidence/'));
if(dirty.length) throw new Error('Source changed inside the qualification container.');
const bundle=inspectBundle({treeHash:source.tree_hash,contentHash:source.content_hash,sha:source.sha});
console.log(JSON.stringify({source_sha:source.sha,source_tree_hash:source.tree_hash,source_content_hash:source.content_hash,bundle_sha256:bundle.sha256,artifact_sha256:bundle.artifact.sha256,artifact_files:bundle.artifact.file_count}));
