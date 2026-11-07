// Local Live — MIT. Standalone WASAPI process-loopback capture.
// Dedicated MTA process; stdout is PCM s16le, 48 kHz, stereo.
// stderr contains newline-delimited JSON status only. No audio is saved to disk.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
// Public Windows SDK layout, also works with MinGW headers lacking this file.
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else
enum PROCESS_LOOPBACK_MODE { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE };
enum AUDIOCLIENT_ACTIVATION_TYPE { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK };
struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE ProcessLoopbackMode; };
struct AUDIOCLIENT_ACTIVATION_PARAMS { AUDIOCLIENT_ACTIVATION_TYPE ActivationType; union { AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; }; };
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif
#include <wrl/client.h>
#include <objidl.h>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <vector>
#include <string>
#include <thread>
#include <atomic>
#include <io.h>
#include <fcntl.h>
using Microsoft::WRL::ComPtr;

class Activation final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
    std::atomic<ULONG> references{1};
    ComPtr<IUnknown> marshaler;
public:
    Activation() { CoCreateFreeThreadedMarshaler(static_cast<IActivateAudioInterfaceCompletionHandler*>(this), &marshaler); }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
    ULONG STDMETHODCALLTYPE Release() override { ULONG count = --references; if (!count) delete this; return count; }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** object) override {
        if (!object) return E_POINTER;
        *object = nullptr;
        if (id == IID_IUnknown || id == __uuidof(IActivateAudioInterfaceCompletionHandler)) *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        else if (id == __uuidof(IAgileObject)) *object = static_cast<IAgileObject*>(this);
        else if (id == IID_IMarshal && marshaler) return marshaler->QueryInterface(id, object);
        else return E_NOINTERFACE;
        AddRef(); return S_OK;
    }
    HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_PENDING;
    ComPtr<IAudioClient> client;
    ~Activation() { if (ready) CloseHandle(ready); }
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activated = E_UNEXPECTED;
        ComPtr<IUnknown> object;
        result = operation->GetActivateResult(&activated, &object);
        if (SUCCEEDED(result)) result = activated;
        if (SUCCEEDED(result)) result = object.As(&client);
        SetEvent(ready);
        return S_OK;
    }
};

static int fail(const char* stage, HRESULT hr) {
    fprintf(stderr, "{\"type\":\"error\",\"stage\":\"%s\",\"hresult\":\"0x%08lX\"}\n", stage, static_cast<unsigned long>(hr));
    fflush(stderr);
    return 1;
}
static bool output(const BYTE* bytes, size_t length) {
    while (length) {
        DWORD written = 0;
        if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, static_cast<DWORD>(length), &written, nullptr) || !written) return false;
        bytes += written; length -= written;
    }
    return true;
}
int main(int argc, char** argv) {
    // Self-test validates launch/protocol/bitness without touching audio APIs.
    if (argc == 2 && std::string(argv[1]) == "--self-test") {
        fputs("{\"type\":\"self-test\",\"protocol\":1}\n", stderr); return 0;
    }
    if (argc != 2) return fail("pid", E_INVALIDARG);
    char* end = nullptr;
    unsigned long parsed = strtoul(argv[1], &end, 10);
    if (!parsed || !end || *end) return fail("pid", E_INVALIDARG);
    _setmode(_fileno(stdout), _O_BINARY);
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return fail("COM", hr);
    // The process exits after capture; COM releases happen before CoUninitialize.
    int result = [&]() -> int {
        ComPtr<Activation> activation; activation.Attach(new Activation());
        if (!activation || !activation->ready) return fail("activation-event", E_OUTOFMEMORY);
        AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
        parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        parameters.ProcessLoopbackParams.TargetProcessId = static_cast<DWORD>(parsed);
        parameters.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
        PROPVARIANT argument{};
        argument.vt = VT_BLOB;
        argument.blob.cbSize = sizeof(parameters);
        argument.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);
        ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
        hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &argument, activation.Get(), &operation);
        if (FAILED(hr)) return fail("ActivateAudioInterfaceAsync", hr);
        if (WaitForSingleObject(activation->ready, 10000) != WAIT_OBJECT_0) return fail("activation-timeout", HRESULT_FROM_WIN32(WAIT_TIMEOUT));
        if (FAILED(activation->result)) return fail("GetActivateResult", activation->result);
        auto client = activation->client;
        // Process-loopback is a virtual endpoint: do not call GetMixFormat.
        WAVEFORMATEX format{};
        format.wFormatTag = WAVE_FORMAT_PCM;
        format.nChannels = 2;
        format.nSamplesPerSec = 48000;
        format.wBitsPerSample = 16;
        format.nBlockAlign = 4;
        format.nAvgBytesPerSec = 192000;
        hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            0, 0, &format, nullptr);
        if (FAILED(hr)) return fail("Initialize", hr);
        ComPtr<IAudioCaptureClient> capture;
        hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(capture.GetAddressOf()));
        if (FAILED(hr)) return fail("GetService", hr);
        HANDLE available = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!available) return fail("sample-event", HRESULT_FROM_WIN32(GetLastError()));
        hr = client->SetEventHandle(available);
        if (FAILED(hr)) { CloseHandle(available); return fail("SetEventHandle", hr); }
        hr = client->Start();
        if (FAILED(hr)) { CloseHandle(available); return fail("Start", hr); }
        fputs("{\"type\":\"ready\",\"sampleRate\":48000,\"channelsPerFrame\":2,\"bitsPerChannel\":16,\"isFloat\":false}\n", stderr);
        fflush(stderr);
        bool running = true;
        int exitCode = 0;
        // Parent closes stdin on stop/exit; no detached helper remains capturing.
        while (running) {
            DWORD inputBytes = 0;
            if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &inputBytes, nullptr) || inputBytes) break;
            DWORD wait = WaitForSingleObject(available, 100);
            if (wait == WAIT_TIMEOUT) continue;
            if (wait != WAIT_OBJECT_0) { exitCode = fail("wait-samples", HRESULT_FROM_WIN32(GetLastError())); break; }
            UINT32 packet = 0;
            hr = capture->GetNextPacketSize(&packet);
            while (SUCCEEDED(hr) && packet) {
                BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
                hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
                if (FAILED(hr)) break;
                std::vector<BYTE> silence;
                size_t length = static_cast<size_t>(frames) * format.nBlockAlign;
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { silence.resize(length, 0); data = silence.data(); }
                running = output(data, length);
                hr = capture->ReleaseBuffer(frames);
                if (!running || FAILED(hr)) break;
                hr = capture->GetNextPacketSize(&packet);
            }
            if (FAILED(hr)) { exitCode = fail("capture", hr); break; }
        }
        client->Stop();
        CloseHandle(available);
        return exitCode;
    }();
    CoUninitialize();
    return result;
}
