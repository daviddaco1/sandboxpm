# escape=`
# sandboxpm script sandbox (Windows)
# Produces Windows-native .node binaries that load on the Windows Node.js runtime.
#
# REQUIREMENT: Docker Desktop must be in Windows containers mode.
#   System Tray → Docker icon → "Switch to Windows containers..."
#
# Image size: ~8 GB (Node 20 + VS Build Tools C++ workload).
# Build once:  docker build -t sandboxpm-sandbox-win:latest .
#
# Base image: Docker Hub's official `node` image has no Windows variant at all
# (confirmed against Docker Hub — it only ever published Linux/amd64/arm tags,
# `node:*-windowsservercore-*` does not exist). So this installs Node.js manually
# on top of a real Microsoft Windows base image instead.
FROM mcr.microsoft.com/windows/servercore:ltsc2022

SHELL ["powershell", "-NoProfile", "-Command"]

# windows/servercore declares no Env at all in its image config (its PATH normally
# comes from the registry at process-creation time, invisible to Docker's builder).
# The first `ENV PATH="...;${PATH}"` we write would therefore substitute `${PATH}`
# as empty and permanently overwrite the container's PATH with just our own
# additions — including for every later RUN layer, which then can't even find
# powershell.exe to execute. Seed the real baseline explicitly before adding to it.
ENV PATH="C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\"

# Matches the Node version the Linux sandbox image runs, installed by extracting
# the official Windows zip distribution (there's no Windows package manager here).
ENV NODE_VERSION=20.20.2
RUN $ProgressPreference = 'SilentlyContinue'; `
    Invoke-WebRequest -UseBasicParsing `
        -Uri "https://nodejs.org/dist/v$env:NODE_VERSION/node-v$env:NODE_VERSION-win-x64.zip" `
        -OutFile 'C:\node.zip'; `
    Expand-Archive -Path 'C:\node.zip' -DestinationPath 'C:\'; `
    Rename-Item -Path "C:\node-v$env:NODE_VERSION-win-x64" -NewName 'nodejs'; `
    Remove-Item 'C:\node.zip'
ENV PATH="C:\\nodejs;${PATH}"

# Fix npm global prefix to a predictable path so NODE_PATH is stable.
RUN npm config set prefix 'C:\npm'
ENV PATH="C:\\npm;C:\\npm\\node_modules\\.bin;${PATH}"

# Install native-module build helpers globally (same set as the Linux image).
RUN npm install -g `
      "@mapbox/node-pre-gyp@1" `
      "prebuild-install@7" `
      "cross-env@7" `
      "node-gyp@10" `
      "node-addon-api@8" `
      "nan@2" ; `
    npm cache clean --force

# Visual Studio Build Tools with just the C++ workload — required for node-gyp.
# Skips --includeRecommended (pulls in optional components node-gyp doesn't need)
# and clears the installer's package cache/temp files in this same layer, since
# anything left behind here is permanent image bloat regardless of later layers.
# Downloads ~1.5 GB at build time; total image is still several GB (MSVC + Windows
# SDK are inherent to native compilation on Windows — not further reducible here).
RUN $ProgressPreference = 'SilentlyContinue'; `
    Invoke-WebRequest -UseBasicParsing `
        -Uri 'https://aka.ms/vs/17/release/vs_buildtools.exe' `
        -OutFile 'C:\vs_buildtools.exe'; `
    Start-Process -FilePath 'C:\vs_buildtools.exe' `
        -ArgumentList '--quiet','--wait','--norestart','--nocache', `
                      '--installPath','C:\BuildTools', `
                      '--add','Microsoft.VisualStudio.Workload.VCTools' `
        -NoNewWindow -Wait; `
    Remove-Item 'C:\vs_buildtools.exe'; `
    Remove-Item -Recurse -Force 'C:\ProgramData\Package Cache' -ErrorAction SilentlyContinue; `
    Remove-Item -Recurse -Force "$env:TEMP\*" -ErrorAction SilentlyContinue

# Tell node-gyp which MSVS version to use.
ENV npm_config_msvs_version=2022

# Pre-download Node.js headers so compilation works without network at runtime.
ENV npm_config_devdir="C:\\node-gyp-headers"
RUN node-gyp install --ensure

WORKDIR C:/sandbox/package

# No ENTRYPOINT — sandboxpm's orchestrator supplies the full Cmd directly.
# No non-root user — Hyper-V isolation (Isolation: hyperv) is the security boundary.
