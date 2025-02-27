// package-simple.ts - Completely revised packaging script
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Configuration
const DIST_DIR = path.join(process.cwd(), 'dist');
const OUTPUT_DIR = path.join(process.cwd(), 'release');
const NODE_MODULES_DIR = path.join(process.cwd(), 'node_modules');
const ENTRY_POINT = path.join(DIST_DIR, 'cli', 'index.js');

// External modules that need special handling
const EXTERNAL_DEPS = [
  'sharp',
  'axios',
  '@triton-one/yellowstone-grpc',
  'canvas'
];

// Ensure directory exists
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Copy node_modules with special handling
function copyExternalDependencies(): void {
  console.log('Copying external dependencies...');
  const targetDir = path.join(OUTPUT_DIR, 'node_modules');
  ensureDir(targetDir);
  
  for (const dep of EXTERNAL_DEPS) {
    const baseName = dep.startsWith('@') ? 
      path.join(dep.split('/')[0], dep.split('/')[1]) :
      dep;
    
    const sourceDir = path.join(NODE_MODULES_DIR, baseName);
    const destDir = path.join(targetDir, baseName);
    
    if (fs.existsSync(sourceDir)) {
      console.log(`Copying ${baseName}...`);
      
      // Make parent directory for scoped packages
      if (dep.startsWith('@') && !fs.existsSync(path.join(targetDir, dep.split('/')[0]))) {
        ensureDir(path.join(targetDir, dep.split('/')[0]));
      }
      
      // Use appropriate copy command based on platform
      if (process.platform === 'win32') {
        execSync(`xcopy /E /I /Y "${sourceDir}" "${destDir}"`, { stdio: 'inherit' });
      } else {
        execSync(`cp -r "${sourceDir}" "${destDir}"`, { stdio: 'inherit' });
      }
    } else {
      console.warn(`⚠️ Warning: Could not find ${baseName} in node_modules`);
    }
  }
}

// Create simple startup scripts
function createStartupScripts(): void {
  console.log('Creating startup scripts...');
  
  // Windows batch file
  const batchContent = `@echo off
echo Starting Eclipse Trader...
set NODE_PATH=%~dp0\\node_modules
"%~dp0\\eclipse-trader.exe" %*
if %ERRORLEVEL% NEQ 0 (
  echo Error occurred. Press any key to exit.
  pause >nul
)
`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'start.bat'), batchContent);
  
  // Create README with instructions
  const readmeContent = `# Eclipse Trader

## Running the Application

### Windows
- Double-click on \`start.bat\` to launch the application
- Alternatively, run the executable directly: \`eclipse-trader.exe\`

## Troubleshooting
If you encounter errors related to missing modules:
1. Make sure the \`node_modules\` directory is present in the same folder as the executable
2. If problems persist, try installing Node.js on your system

## Contact
For support, please contact the developer.
`;
  
  fs.writeFileSync(path.join(OUTPUT_DIR, 'README.md'), readmeContent);
}

// Main packaging function
async function packageApp(): Promise<void> {
  console.log('Starting simplified packaging process...');
  
  // 1. Ensure output directory exists
  ensureDir(OUTPUT_DIR);
  
  // 2. Compile TypeScript
  console.log('Compiling TypeScript...');
  execSync('tsc --project tsconfig.json', { stdio: 'inherit' });
  
  // 3. Check if compiled files exist
  if (!fs.existsSync(ENTRY_POINT)) {
    console.error('❌ Error: Compiled files not found. TypeScript compilation may have failed.');
    process.exit(1);
  }
  
  // 4. Create executable directly without modifying package.json
  console.log('Creating executable...');
  
  // Build the external flags
  const externalFlags = EXTERNAL_DEPS.map(dep => `--external=${dep}`).join(' ');
  
  // Build and execute the pkg command
  const pkgCommand = `npx pkg ${ENTRY_POINT} ${externalFlags} --target node18-win-x64 --output ${path.join(OUTPUT_DIR, 'eclipse-trader.exe')}`;
  console.log(`Running: ${pkgCommand}`);
  
  try {
    execSync(pkgCommand, {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
    });
    
    // 5. Copy external dependencies
    copyExternalDependencies();
    
    // 6. Create startup scripts
    createStartupScripts();
    
    console.log('✅ Packaging complete! Output is in the "release" directory.');
    
  } catch (error) {
    console.error('❌ Error while creating executable:', error);
    throw error;
  }
}

// Run the packaging function
packageApp().catch(error => {
  console.error('❌ Packaging failed:', error);
  process.exit(1);
});
