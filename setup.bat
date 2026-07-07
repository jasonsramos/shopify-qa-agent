@echo off
REM Shopify QA Agent - Windows Setup Script
REM This script creates the project structure and files on Windows

echo Creating Shopify QA Agent project structure...
echo.

REM Create directories
mkdir shopify-qa-agent
cd shopify-qa-agent

mkdir src\layer1\checks
mkdir src\layer2
mkdir src\fix
mkdir configs

echo Directories created.
echo.
echo Next steps:
echo 1. Download all the TypeScript files from the outputs folder
echo 2. Place them in the directories created above
echo 3. Run: npm install
echo 4. Run: npm run build
echo 5. Run: npm run dev -- --help
echo.
echo The project structure is ready. See DOWNLOAD_INSTRUCTIONS.txt for file locations.
