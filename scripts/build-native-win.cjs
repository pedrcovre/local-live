const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const compiler = process.env.LOCAL_LIVE_WINDOWS_CXX || 'x86_64-w64-mingw32-clang++';
const output = path.join(root, 'native-audio/win-x64/local-live-audio.exe');
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(compiler, ['-std=c++17', '-O2', '-static', '-D_WIN32_WINNT=0x0A00', path.join(root, 'native/windows/audio-helper.cpp'), '-o', output, '-lole32', '-lmmdevapi', '-luuid'], { stdio: 'inherit' });
