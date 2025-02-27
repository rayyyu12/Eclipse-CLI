// src/utils/externalModulePatch.js

/**
 * This file handles patching Node.js require system to properly handle
 * external dependencies needed by the application.
 * 
 * When packaged with pkg, some complex modules like axios need special handling
 * to resolve correctly from the external node_modules directory.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

// List of modules we need to patch
const EXTERNAL_MODULES = [
  'axios',
  'sharp',
  '@triton-one/yellowstone-grpc',
  'canvas'
];

/**
 * Find node_modules directory in various locations
 */
function findNodeModulesDir() {
  const possibleLocations = [
    // Next to executable
    path.join(path.dirname(process.execPath), 'node_modules'),
    // Current working directory
    path.join(process.cwd(), 'node_modules'),
    // Up one level (in case we're in executables dir)
    path.join(process.cwd(), '..', 'node_modules')
  ];

  for (const location of possibleLocations) {
    if (fs.existsSync(location)) {
      return location;
    }
  }
  
  return null;
}

/**
 * Patch the require function to handle external modules
 */
function patchRequire() {
  const nodeModulesDir = findNodeModulesDir();
  if (!nodeModulesDir) {
    console.warn(
      '\x1b[33m⚠️  Warning: No node_modules directory found. External modules may not work correctly.\x1b[0m'
    );
    return;
  }

  // Add the node_modules dir to the module paths
  if (!process.env.NODE_PATH) {
    process.env.NODE_PATH = nodeModulesDir;
    Module._initPaths();
  }

  // Store original require
  const originalRequire = Module.prototype.require;

  // Create patched version
  Module.prototype.require = function patchedRequire(id) {
    try {
      // First try normal require
      return originalRequire.call(this, id);
    } catch (err) {
      // If it's not one of our external modules, re-throw
      if (!EXTERNAL_MODULES.some(mod => id === mod || id.startsWith(`${mod}/`))) {
        throw err;
      }

      // For external modules, try various approaches to load them
      try {
        // Try absolute path
        const absolutePath = path.join(nodeModulesDir, id);
        if (fs.existsSync(absolutePath)) {
          console.log(`Loaded external module ${id} from ${absolutePath}`);
          return originalRequire.call(this, absolutePath);
        }

        // For axios specifically, try to work around ESM/CJS issues
        if (id === 'axios') {
          // Try these paths in order
          const axiosPaths = [
            path.join(nodeModulesDir, 'axios', 'dist', 'node', 'axios.cjs'),
            path.join(nodeModulesDir, 'axios', 'index.js'),
            path.join(nodeModulesDir, 'axios', 'dist', 'axios.js')
          ];

          for (const axiosPath of axiosPaths) {
            if (fs.existsSync(axiosPath)) {
              console.log(`Loaded axios from ${axiosPath}`);
              return originalRequire.call(this, axiosPath);
            }
          }
        }

        // If all else fails, throw original error
        throw err;
      } catch (patchError) {
        console.error(`Failed to load external module ${id}:`, patchError);
        throw err; // Throw original error for better diagnostics
      }
    }
  };

  console.log(
    '\x1b[32m✓ Patched require system for external modules\x1b[0m'
  );
}

// Export the patcher function
module.exports = {
  patchRequire
};