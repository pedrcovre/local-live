const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vendor/native-audio-node/native');
const toolchain = path.dirname(path.dirname(execFileSync('xcrun', ['--toolchain', 'default', '--find', 'swiftc'], { encoding: 'utf8' }).trim()));
for (const arch of ['arm64', 'x86_64']) {
  const work = path.join(root, 'native-build', arch); fs.mkdirSync(work, { recursive: true });
  const swift = fs.readdirSync(path.join(source, 'macos/swift')).filter(f => f.endsWith('.swift')).map(f => path.join(source, 'macos/swift', f));
  const library = path.join(work, 'libcoreaudio.a');
  execFileSync('swiftc', ['-emit-library', '-static', '-module-name', 'CoreAudioSwift', '-parse-as-library', '-O', '-target', `${arch}-apple-macosx14.2`, '-module-cache-path', path.join(work, 'module-cache'), '-o', library, ...swift], { stdio: 'inherit' });
  const out = path.join(root, 'native-audio', arch === 'arm64' ? 'mac-arm64' : 'mac-x64'); fs.mkdirSync(out, { recursive: true });
  execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macosx14.2`, '-module-cache-path', path.join(work, 'module-cache'), path.join(root, 'scripts/audio-processes.swift'), '-o', path.join(out, 'audio-processes')], { stdio: 'inherit' });
  const includes = [process.env.LOCAL_LIVE_NODE_HEADERS || '/usr/local/include/node', path.join(root, 'node_modules/node-addon-api'), path.join(source, 'include'), path.join(source, 'napi')];
  execFileSync('clang++', ['-bundle', '-undefined', 'dynamic_lookup', '-std=c++17', '-DNAPI_VERSION=8', '-arch', arch, '-mmacosx-version-min=14.2', ...includes.map(p => `-I${p}`), path.join(source, 'napi/audio_napi.cpp'), library, `-L${toolchain}/lib/swift/macosx`, '-lswiftCore', '-lswiftFoundation', '-lswiftDarwin', '-lswiftDispatch', '-lswiftCoreFoundation', '-lswiftObjectiveC', ...['CoreAudio', 'AudioToolbox', 'AVFoundation', 'Foundation', 'CoreFoundation', 'AppKit'].flatMap(f => ['-framework', f]), '-Wl,-rpath,/usr/lib/swift', '-o', path.join(out, 'native_audio.node')], { stdio: 'inherit' });
  fs.copyFileSync(path.join(root, 'vendor/native-audio-node/NOTICE.txt'), path.join(out, 'NOTICE.txt'));
}
