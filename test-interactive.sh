#!/bin/bash

# Test script for the new interactive mode
# Run this manually to test the file-first navigation

export KODUS_API_URL="http://localhost:3001"

echo "Testing new interactive mode with file-first navigation..."
echo ""
echo "Features:"
echo "  ✓ Shows list of files with issue counts per file"
echo "  ✓ User selects file to review"
echo "  ✓ Shows all issues in that file"
echo "  ✓ Can navigate back to file list"
echo "  ✓ Files removed from list when all issues fixed"
echo ""
echo "Running: kodus review --interactive"
echo ""

node dist/index.js review --interactive
