import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const DIST_DIR = path.join(process.cwd(), 'dist');
const EXECUTABLES_DIR = path.join(process.cwd(), 'executables');
const LAUNCHER_PATH = path.join(DIST_DIR, 'launcher.js');

// Define dependencies that need to remain external (not bundled)
const EXTERNAL_DEPS = [
  'sharp',
  'axios',
  '@triton-one/yellowstone-grpc',
  'canvas'
];

// Write the launcher script to disk before packaging
function createLauncherScript() {
  // The problem was that we weren't creating the launcher script!
  const launcherContent = `#!/usr/bin/env node
// Eclipse Trader Launcher - Startup script for pkg

// First, check if we're running inside a pkg-packaged environment
const isPkg = typeof process.pkg !== 'undefined';
console.log('Starting Eclipse Trader...');

// Set up error handling for unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Fatal error:', err);
  console.error('\\nPlease report this issue with the above error message.');
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Fatal promise rejection:', err);
  console.error('\\nPlease report this issue with the above error message.');
  process.exit(1);
});

// Main function to handle startup
async function main() {
  try {
    const fs = require('fs');
    const path = require('path');
    
    // Determine the application directory
    const appDir = isPkg ? path.dirname(process.execPath) : process.cwd();
    
    // For debugging - log where we're looking for files
    console.log('Application directory:', appDir);
    
    try {
      // Set NODE_PATH to include possible node_modules locations
      process.env.NODE_PATH = [
        path.join(appDir, 'node_modules'),
        path.join(process.cwd(), 'node_modules')
      ].join(path.delimiter);
      
      require('module')._initPaths();
      
      // Try to find the entry point (cli/index.js)
      let entryPoint;
      const possibleEntryPoints = [
        path.join(appDir, 'dist', 'cli', 'index.js'),
        path.join(appDir, 'cli', 'index.js'),
        path.join(process.cwd(), 'dist', 'cli', 'index.js')
      ];
      
      for (const entry of possibleEntryPoints) {
        if (fs.existsSync(entry)) {
          entryPoint = entry;
          console.log('Found entry point:', entry);
          break;
        }
      }
      
      if (!entryPoint) {
        throw new Error('Could not find application entry point');
      }
      
      // Start the application
      require(entryPoint);
    } catch (error) {
      console.error('Failed to start application:', error);
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal startup error:', error);
    process.exit(1);
  }
}

// Start the application
main().catch(err => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
`;

  // Write the launcher script to disk
  console.log('Creating launcher script:', LAUNCHER_PATH);
  fs.writeFileSync(LAUNCHER_PATH, launcherContent);
  
  // Make it executable on Unix systems
  if (process.platform !== 'win32') {
    fs.chmodSync(LAUNCHER_PATH, 0o755);
  }
  
  console.log('✅ Launcher script created');
}

// Ensure directory exists
function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Copy source files to dist
function copySourceToDist() {
  console.log('Ensuring dist directory is ready...');
  
  // For this example, we'll just check if dist/cli exists
  const distCliDir = path.join(DIST_DIR, 'cli');
  if (!fs.existsSync(distCliDir)) {
    console.error(`❌ Error: ${distCliDir} does not exist.`);
    console.error('Make sure TypeScript compilation has completed successfully.');
    process.exit(1);
  }
  
  console.log('✅ Source files ready in dist directory');
}

// Build the executables
async function buildExecutables() {
  console.log('Building executables...');
  
  // Ensure the executables directory exists
  ensureDir(EXECUTABLES_DIR);
  
  // Create the pkg.json config file instead of passing everything on command line
  const pkgConfig = {
    name: "eclipse-trader",
    bin: "launcher.js",
    pkg: {
      assets: ["dist/**/*"],
      targets: [
        "node18-win-x64",
        "node18-linux-x64",
        "node18-macos-x64"
      ],
      outputPath: "executables"
    }
  };
  
  const pkgConfigPath = path.join(DIST_DIR, 'pkg.json');
  fs.writeFileSync(pkgConfigPath, JSON.stringify(pkgConfig, null, 2));
  
  // External dependencies flag for pkg
  const externalFlag = EXTERNAL_DEPS.map(dep => `--external=${dep}`).join(' ');
  
  // Fix: Change the working directory to the dist directory so pkg can find launcher.js
  const originalDir = process.cwd();
  process.chdir(DIST_DIR);
  
  try {
    console.log('Building Windows executable...');
    // Notice: Simplified pkg command and running from dist directory
    execSync(`npx pkg launcher.js --no-bytecode --target node18-win-x64 --output ../executables/eclipse-trader-win.exe ${externalFlag}`, {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
    });
    console.log('✅ Windows executable built successfully');
  } catch (error) {
    console.error('❌ Failed to build Windows executable:', error);
  }
  
  // Change back to original directory
  process.chdir(originalDir);
  
  console.log('Executable build process complete');
}

// Create run scripts
function createRunScripts() {
  console.log('Creating run scripts...');
  
  // Create Windows batch script
  const winBatchScript = `@echo off
echo Starting Eclipse Trader...
set NODE_PATH=%~dp0\\node_modules
"%~dp0\\eclipse-trader-win.exe" %*
`;
  fs.writeFileSync(path.join(EXECUTABLES_DIR, 'run-eclipse.bat'), winBatchScript);
  
  // Create Unix shell script - fixing BASH_SOURCE issue
  const unixShellScript = `#!/bin/bash
echo "Starting Eclipse Trader..."
DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
export NODE_PATH=$DIR/node_modules
"$DIR/eclipse-trader-$(uname | tr '[:upper:]' '[:lower:]')" "$@"
`;
  fs.writeFileSync(path.join(EXECUTABLES_DIR, 'run-eclipse.sh'), unixShellScript);
  fs.chmodSync(path.join(EXECUTABLES_DIR, 'run-eclipse.sh'), 0o755);
  
  console.log('✅ Run scripts created');
}

// Copy node_modules
function copyNodeModules() {
  console.log('Copying required node_modules...');
  
  // Create minimal node_modules directory
  const exeNodeModulesDir = path.join(EXECUTABLES_DIR, 'node_modules');
  ensureDir(exeNodeModulesDir);
  
  // Copy each external dependency
  for (const dep of EXTERNAL_DEPS) {
    const depParts = dep.split('/');
    const baseDep = depParts[0].startsWith('@') ? 
      path.join(depParts[0], depParts[1]) : depParts[0];
    
    const sourceDir = path.join(process.cwd(), 'node_modules', baseDep);
    const targetDir = path.join(exeNodeModulesDir, baseDep);
    
    if (fs.existsSync(sourceDir)) {
      console.log(`Copying ${baseDep}...`);
      
      // Create target directory if it doesn't exist
      if (depParts[0].startsWith('@') && !fs.existsSync(path.join(exeNodeModulesDir, depParts[0]))) {
        fs.mkdirSync(path.join(exeNodeModulesDir, depParts[0]));
      }
      
      // Use appropriate command based on platform
      if (process.platform === 'win32') {
        try {
          execSync(`xcopy /E /I /Y "${sourceDir}" "${targetDir}"`, { stdio: 'inherit' });
        } catch (error) {
          console.error(`❌ Failed to copy ${baseDep}:`, error);
        }
      } else {
        try {
          execSync(`cp -r "${sourceDir}" "${targetDir}"`, { stdio: 'inherit' });
        } catch (error) {
          console.error(`❌ Failed to copy ${baseDep}:`, error);
        }
      }
    } else {
      console.warn(`⚠️ Could not find ${baseDep} in node_modules`);
    }
  }
  
  console.log('✅ Required node_modules copied');
}

// Main build function
async function build() {
  try {
    console.log('Starting build process...');
    
    // Ensure dist directory exists
    ensureDir(DIST_DIR);
    
    // Compile TypeScript
    console.log('Compiling TypeScript...');
    execSync('tsc --project tsconfig.json', { stdio: 'inherit' });
    console.log('✅ TypeScript compiled successfully');
    
    // Copy source files if needed
    copySourceToDist();
    
    // Create the launcher script BEFORE running pkg
    createLauncherScript();
    
    // Build executables
    await buildExecutables();
    
    // Create run scripts
    createRunScripts();
    
    // Copy node_modules
    copyNodeModules();
    
    // Also copy the dist folder to the executables directory for better compatibility
    console.log('Copying dist folder to executables...');
    if (process.platform === 'win32') {
      try {
        execSync(`xcopy /E /I /Y "${DIST_DIR}" "${path.join(EXECUTABLES_DIR, 'dist')}"`, { stdio: 'inherit' });
      } catch (error) {
        console.error(`❌ Failed to copy dist folder:`, error);
      }
    } else {
      try {
        execSync(`cp -r "${DIST_DIR}" "${path.join(EXECUTABLES_DIR, 'dist')}"`, { stdio: 'inherit' });
      } catch (error) {
        console.error(`❌ Failed to copy dist folder:`, error);
      }
    }
    
    console.log('\n🎉 Build completed successfully!');
    console.log(`Executables are available in ${EXECUTABLES_DIR}`);
    console.log('To run the application:');
    console.log('  Windows: run-eclipse.bat');
    console.log('  macOS/Linux: ./run-eclipse.sh');
    
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

// Run the build
build().catch(error => {
  console.error('Fatal build error:', error);
  process.exit(1);
});