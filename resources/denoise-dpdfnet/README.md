# Offline DPDFNet bundle

This directory is included in the Windows installer. Inference uses CPU only;
it does not download models, upload audio, or require Python or an account.

- sherpa-onnx 1.13.8, Windows x64 shared MD Release, no TTS.
- DPDFNet-2 48 kHz HR: official sherpa-onnx speech-enhancement-models release.
- DPDFNet-8 48 kHz HR: official Ceva-IP/DPDFNet repository, pinned revision in
  `dpdfnet8-source.json`.
- ONNX Runtime DLLs come from the same sherpa-onnx distribution. Keep them beside
  the denoiser executable to avoid interfering with the app's other runtimes.

Original release URLs, sizes and SHA-256 digests are recorded in `sources.json`
and `dpdfnet8-source.json`. Both models and the runtime archive were verified
against publisher-provided SHA-256 values before bundling. The DLLs and model
files are unmodified. Licenses are included in this directory.

Upstream:
https://github.com/ceva-ip/DPDFNet
https://github.com/k2-fsa/sherpa-onnx
https://github.com/microsoft/onnxruntime

The app normalizes input to 48 kHz, preserves mono/stereo channels, and processes
60-second segments with 0.5 seconds of neighboring context on either side plus
0.24 seconds of zero padding at each end. sherpa-onnx compensates model delay;
the app removes only context/padding and checks the exact output frame count.
Channels are processed separately, so stereo ambience may change.

The new strength mapping is 6 + 30 * strength dB (19.5 dB at 45%). This is a
suppression limit with aligned original-signal mixing, not measured achieved
noise reduction. It does not enable the legacy post-filter at 65%.
The original DeepFilterNet algorithm remains unchanged.

No universal perceptual quality improvement is claimed. Compare the two models
on the same source, at matched playback volume. Lower strength if speech loses
detail. Missing files or failed inference produce an error, not an undisclosed
switch to another engine.
