using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ClipAssistant.Editor
{
internal static class MltRuntime
{
    sealed class ExportJob
    {
        public readonly string Id = "mlt_" + Guid.NewGuid().ToString("N");
        public readonly string OutputPath;
        public readonly string WorkingPath;
        public readonly string ProjectPath;
        public readonly string Profile;
        public readonly string Format;
        public readonly string VideoCodec;
        public readonly string AudioCodec;
        public readonly string VideoBitrate;
        public readonly string AudioBitrate;
        public readonly string QualityMode;
        public readonly int Width;
        public readonly int Height;
        public readonly bool IncludeVideo;
        public readonly bool IncludeAudio;
        public readonly int FrameRateNumerator;
        public readonly int FrameRateDenominator;
        public readonly long TotalFrames;
        public readonly DateTime StartedAt = DateTime.UtcNow;
        public readonly object Sync = new object();
        public bool CancelRequested;
        public bool PreserveWorkingFile;
        public string State = "preparing";
        public string Error = "";
        public string Message = "正在准备 MLT 时间线…";
        public double Progress;

        public ExportJob(Dictionary<string, object> request, string projectPath, string outputPath, string workingPath)
        {
            ProjectPath = projectPath;
            OutputPath = outputPath;
            WorkingPath = workingPath;
            Format = Text(request, "format", Path.GetExtension(outputPath).TrimStart('.').ToLowerInvariant()).ToLowerInvariant();
            string codec = Text(request, "codec", "h264").ToLowerInvariant();
            string sourceCodec = Text(request, "sourceCodec", "").ToLowerInvariant();
            bool hevc = codec == "hevc" || (codec == "source" && (sourceCodec.Contains("hevc") || sourceCodec.Contains("h265")));
            VideoCodec = Format == "webm" ? "libvpx-vp9" : (hevc ? "libx265" : "libx264");
            AudioCodec = Format == "mp3" ? "libmp3lame" : (Format == "wav" ? "pcm_s16le" : (Format == "webm" ? "libopus" : "aac"));
            VideoBitrate = Text(request, "bitrate", "");
            AudioBitrate = Text(request, "audioBitrate", "192k");
            QualityMode = Text(request, "qualityMode", "balanced");
            Width = Clamp(Integer(request, "width", 1920), 16, 16384);
            Height = Clamp(Integer(request, "height", 1080), 16, 16384);
            IncludeVideo = Boolean(request, "includeVideo", true);
            IncludeAudio = Boolean(request, "includeAudio", true);
            FrameRateNumerator = Clamp(Integer(request, "fpsNumerator", RoundedFrameRate(request)), 1, 240000);
            FrameRateDenominator = Clamp(Integer(request, "fpsDenominator", 1), 1, 1001);
            TotalFrames = Math.Max(1, LongInteger(request, "totalFrames", 1));
            Profile = BuildProfile(Width, Height, FrameRateNumerator, FrameRateDenominator);
        }
    }

    static readonly ConcurrentDictionary<string, ExportJob> jobs = new ConcurrentDictionary<string, ExportJob>();
    static readonly object initLock = new object();
    static readonly object previewLock = new object();
    static bool initialized;
    static string runtimeRoot = "";
    static IntPtr previewProfile = IntPtr.Zero;
    static IntPtr previewProducer = IntPtr.Zero;
    static string previewHash = "";
    static string previewProjectPath = "";

    [DllImport("kernel32.dll", EntryPoint = "SetDllDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetDllDirectory(string path);
    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileEx(string existingFile, string newFile, int flags);

    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr mlt_factory_init(IntPtr directory);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern void mlt_factory_close();
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr mlt_profile_load_string(IntPtr value);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern void mlt_profile_close(IntPtr profile);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr mlt_factory_producer(IntPtr profile, IntPtr service, IntPtr resource);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr mlt_producer_service(IntPtr producer);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern void mlt_producer_close(IntPtr producer);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern void mlt_producer_seek(IntPtr producer, long position);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int mlt_service_get_frame(IntPtr service, out IntPtr frame, int index);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int mlt_frame_get_image(IntPtr frame, ref IntPtr image, ref int format, ref int width, ref int height, int writable);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern void mlt_frame_close(IntPtr frame);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr mlt_factory_consumer(IntPtr profile, IntPtr service, IntPtr input);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr mlt_consumer_properties(IntPtr consumer);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int mlt_properties_set(IntPtr properties, IntPtr name, IntPtr value);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int mlt_properties_set_int(IntPtr properties, IntPtr name, int value);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int mlt_consumer_connect(IntPtr consumer, IntPtr producerService);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int mlt_consumer_start(IntPtr consumer);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int mlt_consumer_stop(IntPtr consumer);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int mlt_consumer_is_stopped(IntPtr consumer);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern long mlt_consumer_position(IntPtr consumer);
    [DllImport("libmlt-7.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern void mlt_consumer_close(IntPtr consumer);

    public static Dictionary<string, object> Start(Dictionary<string, object> request, string installRoot)
    {
        if (request == null) throw new ArgumentNullException("request");
        if (!String.Equals(Text(request, "supported", "false"), "true", StringComparison.OrdinalIgnoreCase) &&
            !(request.ContainsKey("supported") && request["supported"] is bool && (bool)request["supported"]))
            throw new InvalidOperationException("该项目包含尚未迁移的效果，不能交给 MLT 渲染。");
        string xml = Text(request, "projectXml", "");
        string outputValue = Text(request, "outputPath", "");
        if (String.IsNullOrWhiteSpace(outputValue)) throw new InvalidOperationException("导出路径为空。");
        string output = Path.GetFullPath(outputValue);
        if (String.IsNullOrWhiteSpace(xml) || xml.Length > 20 * 1024 * 1024)
            throw new InvalidOperationException("MLT 项目时间线为空或超过安全大小限制。");
        if (String.IsNullOrWhiteSpace(output) || !Directory.Exists(Path.GetDirectoryName(output)))
            throw new InvalidOperationException("导出路径无效或目标文件夹不存在。");
        string format = Text(request, "format", Path.GetExtension(output).TrimStart('.').ToLowerInvariant()).ToLowerInvariant();
        if (Array.IndexOf(new[] { "mp4", "mov", "mkv", "webm", "mp3", "wav" }, format) < 0)
            throw new InvalidOperationException("MLT 导出暂不支持该文件格式。");
        if (request.ContainsKey("sourcePaths") && request["sourcePaths"] is IEnumerable)
        {
            foreach (object value in (IEnumerable)request["sourcePaths"])
            {
                string source = Convert.ToString(value);
                if (String.IsNullOrWhiteSpace(source)) continue;
                string fullSource = Path.GetFullPath(source);
                if (String.Equals(fullSource, output, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("导出路径与时间线中的源素材相同。请另选文件名，避免覆盖原素材。");
                if (!File.Exists(fullSource))
                    throw new InvalidOperationException("时间线素材不存在或已移动：" + fullSource);
            }
        }

        EnsureInitialized(installRoot);
        string projectDirectory = Path.Combine(Path.GetTempPath(), "ClipAssistant", "mlt-projects");
        Directory.CreateDirectory(projectDirectory);
        string token = Guid.NewGuid().ToString("N");
        string projectPath = Path.Combine(projectDirectory, "timeline-" + token + ".mlt");
        string workingPath = Path.Combine(Path.GetDirectoryName(output), ".export-" + token + Path.GetExtension(output));
        try
        {
            File.WriteAllText(projectPath, xml, new UTF8Encoding(false));
            var job = new ExportJob(request, projectPath, output, workingPath);
            if (!jobs.TryAdd(job.Id, job)) throw new InvalidOperationException("无法登记 MLT 导出任务。");
            Task.Run(() => Run(job));
            return Snapshot(job);
        }
        catch
        {
            try { if (File.Exists(projectPath)) File.Delete(projectPath); } catch { }
            throw;
        }
    }

    public static Dictionary<string, object> Status(string id)
    {
        ExportJob job;
        if (!jobs.TryGetValue(Convert.ToString(id), out job))
            throw new InvalidOperationException("找不到该 MLT 导出任务。");
        return Snapshot(job);
    }

    public static Dictionary<string, object> Cancel(string id)
    {
        ExportJob job;
        if (!jobs.TryGetValue(Convert.ToString(id), out job))
            throw new InvalidOperationException("找不到该 MLT 导出任务。");
        lock (job.Sync) job.CancelRequested = true;
        return Snapshot(job);
    }

    public static Dictionary<string, object> PreviewFrame(Dictionary<string, object> request, string installRoot)
    {
        if (request == null) throw new ArgumentNullException("request");
        if (!Boolean(request, "supported", false))
            throw new InvalidOperationException("当前时间线包含尚未迁移到 MLT 的预览效果。");
        string xml = Text(request, "projectXml", "");
        if (String.IsNullOrWhiteSpace(xml) || xml.Length > 20 * 1024 * 1024)
            throw new InvalidOperationException("MLT 预览时间线为空或超过安全大小限制。");
        if (request.ContainsKey("sourcePaths") && request["sourcePaths"] is IEnumerable)
        {
            foreach (object value in (IEnumerable)request["sourcePaths"])
            {
                string source = Convert.ToString(value);
                if (!String.IsNullOrWhiteSpace(source) && !File.Exists(Path.GetFullPath(source)))
                    throw new InvalidOperationException("时间线素材不存在或已移动：" + source);
            }
        }

        EnsureInitialized(installRoot);
        int width = Clamp(Integer(request, "width", 1920), 16, 16384);
        int height = Clamp(Integer(request, "height", 1080), 16, 16384);
        int fpsNumerator = Clamp(Integer(request, "fpsNumerator", RoundedFrameRate(request)), 1, 240000);
        int fpsDenominator = Clamp(Integer(request, "fpsDenominator", 1), 1, 1001);
        long totalFrames = Math.Max(1, LongInteger(request, "totalFrames", 1));
        long frameIndex = Math.Max(0, Math.Min(totalFrames - 1, LongInteger(request, "frameIndex", 0)));
        string hash;
        using (SHA256 sha = SHA256.Create())
            hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(xml))).Replace("-", "").ToLowerInvariant();

        lock (previewLock)
        {
            EnsurePreviewProducer(xml, hash, width, height, fpsNumerator, fpsDenominator);
            IntPtr frame = IntPtr.Zero;
            try
            {
                mlt_producer_seek(previewProducer, frameIndex);
                if (mlt_service_get_frame(mlt_producer_service(previewProducer), out frame, 0) != 0 || frame == IntPtr.Zero)
                    throw new InvalidOperationException("MLT 无法读取当前时间线帧。");
                IntPtr image = IntPtr.Zero;
                int imageFormat = 2; // mlt_image_rgba
                int imageWidth = 0, imageHeight = 0;
                if (mlt_frame_get_image(frame, ref image, ref imageFormat, ref imageWidth, ref imageHeight, 0) != 0 || image == IntPtr.Zero)
                    throw new InvalidOperationException("MLT 无法合成当前预览画面。");
                long byteCount = (long)imageWidth * imageHeight * 4;
                if (imageWidth < 1 || imageHeight < 1 || byteCount > 160L * 1024 * 1024)
                    throw new InvalidOperationException("MLT 返回的预览帧尺寸无效或过大。");
                if (imageFormat != 2)
                    throw new InvalidOperationException("MLT 返回了不支持的预览图像格式。");
                byte[] pixels = new byte[(int)byteCount];
                Marshal.Copy(image, pixels, 0, pixels.Length);
                for (int i = 0; i < pixels.Length; i += 4)
                {
                    byte red = pixels[i];
                    pixels[i] = pixels[i + 2];
                    pixels[i + 2] = red;
                }
                int previewWidth, previewHeight;
                byte[] jpeg = EncodePreviewJpeg(pixels, imageWidth, imageHeight, out previewWidth, out previewHeight);
                return new Dictionary<string, object> {
                    { "frameIndex", frameIndex }, { "data", Convert.ToBase64String(jpeg) },
                    { "width", previewWidth }, { "height", previewHeight }
                };
            }
            finally { if (frame != IntPtr.Zero) mlt_frame_close(frame); }
        }
    }

    static void EnsurePreviewProducer(string xml, string hash, int width, int height, int fpsNumerator, int fpsDenominator)
    {
        if (previewProducer != IntPtr.Zero && previewProfile != IntPtr.Zero && previewHash == hash) return;
        ClosePreviewProducer();
        string directory = Path.Combine(Path.GetTempPath(), "ClipAssistant", "mlt-projects");
        Directory.CreateDirectory(directory);
        previewProjectPath = Path.Combine(directory, "preview-" + hash + ".mlt");
        File.WriteAllText(previewProjectPath, xml, new UTF8Encoding(false));
        previewProfile = CallWithUtf8(BuildProfile(width, height, fpsNumerator, fpsDenominator), value => mlt_profile_load_string(value));
        if (previewProfile == IntPtr.Zero)
        {
            ClosePreviewProducer();
            throw new InvalidOperationException("无法为 MLT 预览建立帧率配置。");
        }
        previewProducer = CallWithUtf8("xml", service => CallWithUtf8(previewProjectPath,
            resource => mlt_factory_producer(previewProfile, service, resource)));
        if (previewProducer == IntPtr.Zero)
        {
            ClosePreviewProducer();
            throw new InvalidOperationException("MLT 无法打开本地时间线预览。");
        }
        previewHash = hash;
    }

    static byte[] EncodePreviewJpeg(byte[] pixels, int width, int height, out int resultWidth, out int resultHeight)
    {
        int maxWidth = 1280, maxHeight = 1280;
        double scale = Math.Min(1.0, Math.Min((double)maxWidth / width, (double)maxHeight / height));
        resultWidth = Math.Max(1, (int)Math.Round(width * scale));
        resultHeight = Math.Max(1, (int)Math.Round(height * scale));
        using (Bitmap source = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            BitmapData sourceData = source.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                if (sourceData.Stride == width * 4) Marshal.Copy(pixels, 0, sourceData.Scan0, pixels.Length);
                else
                {
                    for (int row = 0; row < height; row++)
                        Marshal.Copy(pixels, row * width * 4, IntPtr.Add(sourceData.Scan0, row * sourceData.Stride), width * 4);
                }
            }
            finally { source.UnlockBits(sourceData); }
            using (Bitmap output = new Bitmap(resultWidth, resultHeight, PixelFormat.Format24bppRgb))
            using (Graphics graphics = Graphics.FromImage(output))
            using (MemoryStream stream = new MemoryStream())
            {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                graphics.DrawImage(source, new Rectangle(0, 0, resultWidth, resultHeight));
                ImageCodecInfo encoder = null;
                foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders())
                    if (candidate.MimeType == "image/jpeg") { encoder = candidate; break; }
                if (encoder == null) throw new InvalidOperationException("系统缺少 JPEG 预览编码器。");
                using (EncoderParameters parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
                    output.Save(stream, encoder, parameters);
                }
                return stream.ToArray();
            }
        }
    }

    public static void ClosePreview()
    {
        lock (previewLock) ClosePreviewProducer();
    }

    static void ClosePreviewProducer()
    {
        if (previewProducer != IntPtr.Zero) { mlt_producer_close(previewProducer); previewProducer = IntPtr.Zero; }
        if (previewProfile != IntPtr.Zero) { mlt_profile_close(previewProfile); previewProfile = IntPtr.Zero; }
        if (!String.IsNullOrEmpty(previewProjectPath))
        {
            try { if (File.Exists(previewProjectPath)) File.Delete(previewProjectPath); } catch { }
        }
        previewProjectPath = "";
        previewHash = "";
    }

    static void EnsureInitialized(string installRoot)
    {
        lock (initLock)
        {
            if (initialized) return;
            string hostDirectory = Path.GetDirectoryName(typeof(MltRuntime).Assembly.Location) ?? "";
            string[] candidates = new[] {
                Path.Combine(hostDirectory, "resources", "mlt"),
                Path.Combine(installRoot, "resources", "mlt"),
                Path.Combine(installRoot, "_internal", "resources", "mlt"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "resources", "mlt"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "_internal", "resources", "mlt"),
                Path.Combine(installRoot, ".build", "mlt-runtime-7.42")
            };
            runtimeRoot = candidates[0];
            foreach (string candidate in candidates) {
                if (File.Exists(Path.Combine(candidate, "libmlt-7.dll"))) { runtimeRoot = candidate; break; }
            }
            string library = Path.Combine(runtimeRoot, "libmlt-7.dll");
            string modules = Path.Combine(runtimeRoot, "lib", "mlt");
            string data = Path.Combine(runtimeRoot, "share", "mlt");
            if (!File.Exists(library) || !File.Exists(Path.Combine(modules, "libmltcore.dll")) ||
                !File.Exists(Path.Combine(modules, "libmltplus.dll")) ||
                !File.Exists(Path.Combine(modules, "libmltavformat.dll")) ||
                !File.Exists(Path.Combine(modules, "libmltxml.dll")) || !Directory.Exists(data))
                throw new InvalidOperationException("本地 MLT 运行库不完整，无法启动剪辑核心。");
            if (!SetDllDirectory(runtimeRoot))
                throw new InvalidOperationException("无法设置本地 MLT 依赖搜索路径。");
            Environment.SetEnvironmentVariable("MLT_REPOSITORY", modules);
            Environment.SetEnvironmentVariable("MLT_DATA", data);
            Environment.SetEnvironmentVariable("PATH", runtimeRoot + ";" + Environment.GetEnvironmentVariable("PATH"));
            IntPtr path = Utf8(modules);
            try
            {
                if (mlt_factory_init(path) == IntPtr.Zero)
                    throw new InvalidOperationException("MLT 核心初始化失败。");
            }
            finally { Marshal.FreeHGlobal(path); }
            initialized = true;
        }
    }

    static void Run(ExportJob job)
    {
        IntPtr profile = IntPtr.Zero, producer = IntPtr.Zero, consumer = IntPtr.Zero;
        try
        {
            Thread.CurrentThread.Priority = ThreadPriority.BelowNormal;
            lock (job.Sync) { job.State = "exporting"; job.Message = "MLT 正在逐帧渲染…"; }
            profile = CallWithUtf8(job.Profile, value => mlt_profile_load_string(value));
            if (profile == IntPtr.Zero) throw new InvalidOperationException("无法为 MLT 时间线建立帧率配置。");
            producer = CallWithUtf8("xml", service => CallWithUtf8(job.ProjectPath, resource => mlt_factory_producer(profile, service, resource)));
            if (producer == IntPtr.Zero) throw new InvalidOperationException("MLT 无法读取生成的项目时间线。");
            consumer = CallWithUtf8("avformat", service => CallWithUtf8(job.WorkingPath, path => mlt_factory_consumer(profile, service, path)));
            if (consumer == IntPtr.Zero) throw new InvalidOperationException("MLT 的本地媒体输出模块无法创建。");
            IntPtr properties = mlt_consumer_properties(consumer);
            SetProperty(properties, "f", job.Format);
            bool audioOnly = job.Format == "mp3" || job.Format == "wav";
            if (audioOnly || !job.IncludeVideo) SetIntProperty(properties, "vn", 1);
            if (!job.IncludeAudio) SetIntProperty(properties, "an", 1);
            else SetProperty(properties, "vcodec", job.VideoCodec);
            SetProperty(properties, "acodec", job.AudioCodec);
            SetProperty(properties, "vb", job.VideoBitrate);
            SetProperty(properties, "ab", job.AudioBitrate);
            if (job.QualityMode == "fast") SetProperty(properties, "preset", "veryfast");
            else if (job.QualityMode == "maximum") SetProperty(properties, "preset", "slow");
            else SetProperty(properties, "preset", "medium");
            SetProperty(properties, "threads", Math.Max(1, Math.Min(6, Environment.ProcessorCount - 1)).ToString());
            SetIntProperty(properties, "real_time", -1);
            SetIntProperty(properties, "progress", 1);
            IntPtr producerService = mlt_producer_service(producer);
            if (producerService == IntPtr.Zero || mlt_consumer_connect(consumer, producerService) != 0)
                throw new InvalidOperationException("MLT 无法连接时间线和输出模块。");
            if (mlt_consumer_start(consumer) != 0)
                throw new InvalidOperationException("MLT 无法启动本地渲染。");

            while (mlt_consumer_is_stopped(consumer) == 0)
            {
                bool cancel;
                lock (job.Sync) cancel = job.CancelRequested;
                if (cancel)
                {
                    mlt_consumer_stop(consumer);
                    lock (job.Sync) { job.State = "cancelled"; job.Message = "已取消 MLT 导出。"; }
                    return;
                }
                long position = Math.Max(0, mlt_consumer_position(consumer));
                lock (job.Sync)
                {
                    job.Progress = Math.Max(job.Progress, Math.Min(.99, (double)position / Math.Max(1, job.TotalFrames)));
                }
                Thread.Sleep(150);
            }

            if (!File.Exists(job.WorkingPath) || new FileInfo(job.WorkingPath).Length == 0)
                throw new InvalidOperationException("MLT 没有生成有效的导出文件。");
            if (!MoveFileEx(job.WorkingPath, job.OutputPath, 0x1 | 0x8)) {
                int code = Marshal.GetLastWin32Error();
                lock (job.Sync) job.PreserveWorkingFile = true;
                throw new InvalidOperationException("成片已生成，但无法安全替换目标文件。请关闭占用该文件的程序；临时成片保留在：" + job.WorkingPath + "（Windows " + code + "）。");
            }
            lock (job.Sync) { job.State = "completed"; job.Progress = 1; job.Message = "MLT 导出完成。"; }
        }
        catch (Exception ex)
        {
            lock (job.Sync) { job.State = "failed"; job.Error = ex.Message; job.Message = "MLT 导出失败。"; }
        }
        finally
        {
            if (consumer != IntPtr.Zero) mlt_consumer_close(consumer);
            if (producer != IntPtr.Zero) mlt_producer_close(producer);
            if (profile != IntPtr.Zero) mlt_profile_close(profile);
            try { if (File.Exists(job.ProjectPath)) File.Delete(job.ProjectPath); } catch { }
            try { if (!job.PreserveWorkingFile && File.Exists(job.WorkingPath)) File.Delete(job.WorkingPath); } catch { }
        }
    }

    static Dictionary<string, object> Snapshot(ExportJob job)
    {
        lock (job.Sync)
        {
            return new Dictionary<string, object> {
                { "jobId", job.Id }, { "state", job.State }, { "progress", job.Progress },
                { "outputPath", job.OutputPath }, { "error", job.Error }, { "message", job.Message },
                { "elapsed", Math.Max(0, (DateTime.UtcNow - job.StartedAt).TotalSeconds) },
                { "encoderLabel", "MLT 本地核心" }
            };
        }
    }

    static string BuildProfile(int width, int height, int fpsNumerator, int fpsDenominator)
    {
        int gcd = Gcd(fpsNumerator, fpsDenominator);
        fpsNumerator /= gcd; fpsDenominator /= gcd;
        int darGcd = Gcd(width, height);
        return "description=ClipAssistant\n" +
            "frame_rate_num=" + fpsNumerator + "\n" +
            "frame_rate_den=" + fpsDenominator + "\n" +
            "width=" + width + "\nheight=" + height + "\nprogressive=1\n" +
            "sample_aspect_num=1\nsample_aspect_den=1\n" +
            "display_aspect_num=" + (width / darGcd) + "\ndisplay_aspect_den=" + (height / darGcd) + "\ncolorspace=709\n";
    }

    static void SetProperty(IntPtr properties, string name, string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return;
        IntPtr nativeName = Utf8(name), nativeValue = Utf8(value);
        try { mlt_properties_set(properties, nativeName, nativeValue); }
        finally { Marshal.FreeHGlobal(nativeName); Marshal.FreeHGlobal(nativeValue); }
    }

    static void SetIntProperty(IntPtr properties, string name, int value)
    {
        IntPtr nativeName = Utf8(name);
        try { mlt_properties_set_int(properties, nativeName, value); }
        finally { Marshal.FreeHGlobal(nativeName); }
    }

    static IntPtr CallWithUtf8(string value, Func<IntPtr, IntPtr> call)
    {
        IntPtr native = Utf8(value);
        try { return call(native); }
        finally { Marshal.FreeHGlobal(native); }
    }

    static IntPtr Utf8(string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes((value ?? "") + "\0");
        IntPtr native = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, native, bytes.Length);
        return native;
    }

    static string Text(Dictionary<string, object> value, string key, string fallback)
    {
        return value != null && value.ContainsKey(key) && value[key] != null ? Convert.ToString(value[key]) : fallback;
    }

    static int Integer(Dictionary<string, object> value, string key, int fallback)
    {
        int parsed; return Int32.TryParse(Text(value, key, ""), out parsed) ? parsed : fallback;
    }

    static bool Boolean(Dictionary<string, object> value, string key, bool fallback)
    {
        bool parsed; return System.Boolean.TryParse(Text(value, key, ""), out parsed) ? parsed : fallback;
    }

    static int RoundedFrameRate(Dictionary<string, object> value)
    {
        double parsed;
        return Double.TryParse(Text(value, "fps", ""), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out parsed) ? (int)Math.Round(parsed) : 30;
    }

    static long LongInteger(Dictionary<string, object> value, string key, long fallback)
    {
        long parsed; return Int64.TryParse(Text(value, key, ""), out parsed) ? parsed : fallback;
    }

    static int Clamp(int value, int minimum, int maximum) { return Math.Max(minimum, Math.Min(maximum, value)); }
    static int Gcd(int left, int right) { int a = Math.Abs(left), b = Math.Abs(right); while (b != 0) { int next = a % b; a = b; b = next; } return Math.Max(1, a); }
}
}
