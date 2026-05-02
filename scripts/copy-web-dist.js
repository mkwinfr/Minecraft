#!/usr/bin/env node

/**
 * Copy web dist build to API public folder for production deployment
 * Usage: node scripts/copy-web-dist.js
 */

const { promises: fs } = require('fs');
const { resolve, join } = require('path');

const rootDir = resolve(__dirname, '..');

const srcDir = resolve(rootDir, 'apps/web/dist');
const destDir = resolve(rootDir, 'apps/api/public');

async function copyWebDist() {
  try {
    console.log('📦 Copying web build to API public folder...');

    // Remove existing public folder
    try {
      await fs.rm(destDir, { recursive: true, force: true });
      console.log('  ✓ Removed existing public folder');
    } catch (err) {
      // Ignore if doesn't exist
    }

    // Copy web dist to public
    await fs.cp(srcDir, destDir, { recursive: true });
    console.log(`  ✓ Copied ${srcDir}`);
    console.log(`    → ${destDir}`);

    // Verify index.html exists
    const indexPath = join(destDir, 'index.html');
    try {
      await fs.access(indexPath);
      console.log('  ✓ index.html verified in public folder');
    } catch {
      throw new Error(`index.html not found at ${indexPath}`);
    }

    console.log('✨ Web build copied successfully');
  } catch (err) {
    console.error('❌ Error copying web dist:', err.message);
    process.exit(1);
  }
}

copyWebDist();
