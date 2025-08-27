#!/bin/bash

# LeetTracker Extension Build Script
BUILD_TYPE=${1:-dev}  # Default to dev if no argument provided
SHOULD_ZIP=${2:-false}  # Default to no zip

echo "🚀 Building LeetTracker Extension (${BUILD_TYPE})..."

# Create build directory structure
mkdir -p build/src
mkdir -p build/lib

# Copy main files to src subfolder for organization
echo "📁 Copying main files..."
cp inject_webapp.js build/src/
cp *.png build/src/

# Copy appropriate manifest to src folder based on build type
if [ "$BUILD_TYPE" = "prod" ]; then
    echo "📄 Using production manifest..."
    cp manifest.prod.json build/src/manifest.json
else
    echo "📄 Using development manifest..."
    cp manifest.dev.json build/src/manifest.json
fi

# Download diff library if it doesn't exist
if [ ! -f "build/lib/diff.min.js" ]; then
    echo "📦 Downloading diff library..."
    mkdir -p build/lib
    curl -o build/lib/diff.min.js https://cdn.jsdelivr.net/npm/diff@5.1.0/dist/diff.min.js
else
    echo "✅ Diff library already exists"
fi

# Combine diff library with content.js to avoid loading issues
echo "🔗 Combining diff library with content.js..."
cat build/lib/diff.min.js > build/src/content.js
echo "" >> build/src/content.js
cat content.js >> build/src/content.js

# Create a simple version bump (optional)
if [ "$1" = "--version-bump" ] || [ "$2" = "--version-bump" ]; then
    echo "🔢 Bumping version..."
    # Extract current version from production manifest
    current_version=$(grep '"version"' manifest.prod.json | sed 's/.*"version": "\([^"]*\)".*/\1/')
    echo "Current version: $current_version"
    
    # Simple patch version bump (you can make this more sophisticated)
    IFS='.' read -ra VERSION_PARTS <<< "$current_version"
    new_patch=$((${VERSION_PARTS[2]} + 1))
    new_version="${VERSION_PARTS[0]}.${VERSION_PARTS[1]}.$new_patch"
    
    echo "New version: $new_version"
    
    # Update version in both manifest files and src manifest
    sed -i '' "s/\"version\": \"$current_version\"/\"version\": \"$new_version\"/" manifest.dev.json
    sed -i '' "s/\"version\": \"$current_version\"/\"version\": \"$new_version\"/" manifest.prod.json
    sed -i '' "s/\"version\": \"$current_version\"/\"version\": \"$new_version\"/" build/src/manifest.json
fi

# Create zip if requested
if [ "$BUILD_TYPE" = "prod" ] || [ "$SHOULD_ZIP" = "true" ] || [ "$1" = "--zip" ] || [ "$2" = "--zip" ]; then
    echo "📦 Creating distribution zip..."
    cd build/src
    zip -r "../leet-tracker-extension.zip" . -x "*.DS_Store"
    cd ../..
    echo "✅ Created build/leet-tracker-extension.zip"
fi

echo "✅ Build complete! Extension ready in ./build/src/"
echo ""
if [ "$BUILD_TYPE" = "prod" ]; then
    echo "🎯 Production build ready!"
    echo "📦 Upload build/leet-tracker-extension.zip to Chrome Web Store"
else
    echo "🛠️  Development build ready!"
    echo "📦 To load in Chrome:"
    echo "1. Open Chrome Extensions (chrome://extensions/)"
    echo "2. Enable Developer Mode"
    echo "3. Click 'Load unpacked' and select the ./build/src/ folder"
fi
echo ""
