#!/bin/bash
# Força o script a parar imediatamente se houver algum erro
set -e

echo "📦 [1/4] Limpando compilações antigas..."
rm -rf dist
rm -rf src-tauri/target

echo "⚡ [2/4] Rodando o build de produção do React (Vite)..."
npm run build

echo "🖥️ [3/4] Compilando e empacotando o app Desktop (Linux AppImage)..."
npx tauri build

echo "📱 [4/4] Compilando e gerando o APK para Android..."
npx tauri android build

echo "🚀 CONCLUÍDO COM SUCESSO!"
echo "--------------------------------------------------------"
echo "🖥️ Executável Desktop: ./src-tauri/target/release/bundle/appimage/"
echo "📱 Executável Android (APK): ./src-tauri/gen/android/app/build/outputs/apk/release/"
echo "--------------------------------------------------------"
