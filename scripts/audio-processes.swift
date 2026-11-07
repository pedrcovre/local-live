import Foundation
import CoreAudio

var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var size: UInt32 = 0
guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { exit(1) }
if size == 0 { print("[]"); exit(0) }
var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
let status = objects.withUnsafeMutableBytes { bytes in AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, bytes.baseAddress!) }
guard status == noErr else { exit(1) }
var result: [[String: Int]] = []
for object in objects {
    var property = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyPID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var pid: pid_t = 0
    var bytes = UInt32(MemoryLayout<pid_t>.size)
    if AudioObjectGetPropertyData(object, &property, 0, nil, &bytes, &pid) == noErr && pid > 0 {
        result.append(["pid": Int(pid), "audioObject": Int(object)])
    }
}
let data = try JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(data)
