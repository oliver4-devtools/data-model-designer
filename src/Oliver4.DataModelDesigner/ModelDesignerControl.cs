using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using McTools.Xrm.Connection;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Xrm.Sdk;
using Newtonsoft.Json;
using Oliver4.DataModelDesigner.Bridge;
using Oliver4.DataModelDesigner.Metadata;
using Oliver4.DataModelDesigner.Model;
using XrmToolBox.Extensibility;
using XrmToolBox.Extensibility.Args;
using XrmToolBox.Extensibility.Interfaces;

namespace Oliver4.DataModelDesigner
{
    /// <summary>
    /// The tool surface. This class is kept thin: it owns the WebView2 that renders the
    /// canvas, translates bridge calls into host work, and holds the Dataverse connection. All
    /// diagram logic lives either in the web app or in the service classes.
    /// </summary>
    public partial class ModelDesignerControl : PluginControlBase, IHostServices, IStatusBarMessenger,
        IGitHubPlugin, IHelpPlugin, IAboutPlugin
    {
        /// <summary>
        /// Origin the embedded web app is served from. Nothing is fetched over the network: every
        /// request to this host is answered from resources compiled into this assembly.
        /// </summary>
        private const string AppOrigin = "https://data-model-designer.local/";

        private const string ResourceRoot = "Oliver4.DataModelDesigner.Web.";

        /// <summary>
        /// How many messages to hold for a canvas that has not finished loading. Boot is a handful
        /// of calls, so anything past this means the canvas is never going to arrive.
        /// </summary>
        private const int MaxPendingMessages = 200;

        private WebView2 _webView;
        private System.Windows.Forms.Label _statusLabel;
        private HostBridge _bridge;
        private MetadataService _metadata;
        private ToolSettings _settings = new ToolSettings();

        /// <summary>
        /// Every bridge request still running, by request id. The canvas issues calls concurrently
        /// - the explorer, the table catalogue and a metadata load can all be in flight at once -
        /// so cancellation has to reach all of them, not just the most recent.
        /// </summary>
        private readonly Dictionary<string, CancellationTokenSource> _inFlight =
            new Dictionary<string, CancellationTokenSource>(StringComparer.Ordinal);

        private readonly object _workLock = new object();
        private bool _webViewReady;
        private bool _isDirty;

        /// <summary>
        /// Messages posted before the canvas finished loading, in the order they were produced.
        ///
        /// app.js is a module script, so bootstrap() posts settings.get and app.info before
        /// NavigationCompleted can fire. bridge.js has no timeout, so an answer dropped in that
        /// window would leave its promise unsettled - no saved theme, no recent files, no version
        /// in the About box. Holding the messages here avoids that.
        ///
        /// UI thread only - PostToWeb marshals before it touches this.
        ///
        /// Each entry carries the event name it was posted under, or null for a response, so the
        /// flush can tell one kind of held message from another. See OnNavigationCompleted, which
        /// drops a held connection event rather than letting the canvas be told twice.
        /// </summary>
        private readonly List<PendingMessage> _pendingMessages = new List<PendingMessage>();

        /// <summary>A message held until the canvas exists, and what it was.</summary>
        private sealed class PendingMessage
        {
            public string Json;
            public string EventName;
        }

        public ModelDesignerControl()
        {
            InitializeComponent();

            ToolName = PluginInfo.ToolName;
            _bridge = new HostBridge(this);

            ToolSettings loaded;
            if (SettingsManager.Instance.TryLoad(typeof(ModelDesignerControl), out loaded) && loaded != null)
                _settings = loaded;

            Load += OnControlLoad;
        }

        public event EventHandler<StatusBarMessageEventArgs> SendMessageToStatusBar;

        // ------------------------------------------------------------------
        // XrmToolBox integration
        // ------------------------------------------------------------------

        public string RepositoryName => PluginInfo.RepositoryName;
        public string UserName => PluginInfo.RepositoryOwner;
        public string HelpUrl => PluginInfo.HelpUrl;

        public void ShowAboutDialog()
        {
            MessageBox.Show(
                PluginInfo.ToolName + " " + PluginInfo.Version + Environment.NewLine + Environment.NewLine +
                "Explore, design and document a Dataverse data model." + Environment.NewLine + Environment.NewLine +
                "This tool only ever reads metadata. Nothing it does changes the connected environment." +
                Environment.NewLine + Environment.NewLine +
                PluginInfo.HelpUrl,
                "About " + PluginInfo.ToolName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }

        public override void UpdateConnection(IOrganizationService newService, ConnectionDetail detail, string actionName, object parameter)
        {
            base.UpdateConnection(newService, detail, actionName, parameter);

            // The old service's cache described a different environment. Dropping the whole
            // MetadataService rather than clearing it means nothing can hold a stale reference.
            if (_metadata != null) _metadata.Progress -= OnMetadataProgress;

            _metadata = newService == null ? null : new MetadataService(newService);
            if (_metadata != null)
                _metadata.Progress += OnMetadataProgress;

            // Work in flight was reading the environment we have just left, so its results would
            // describe the wrong one by the time they arrived.
            CancelAllWork();

            PostEvent(BridgeEvents.ConnectionChanged, Connection);
        }

        public override void ClosingPlugin(PluginCloseInfo info)
        {
            if (info.FormReason != CloseReason.None ||
                info.ToolBoxReason == ToolBoxCloseReason.CloseAll ||
                info.ToolBoxReason == ToolBoxCloseReason.CloseAllExceptActive)
            {
                base.ClosingPlugin(info);
                return;
            }

            if (_isDirty && _settings.ConfirmBeforeClosingUnsaved)
            {
                var answer = MessageBox.Show(
                    "This diagram has unsaved changes. Close it anyway?",
                    PluginInfo.ToolName,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning,
                    MessageBoxDefaultButton.Button2);

                if (answer == DialogResult.No)
                {
                    info.Cancel = true;
                    return;
                }
            }

            CancelAllWork();
            base.ClosingPlugin(info);
        }

        // ------------------------------------------------------------------
        // Web view lifecycle
        // ------------------------------------------------------------------

        private async void OnControlLoad(object sender, EventArgs e)
        {
            Load -= OnControlLoad;

            try
            {
                await InitialiseWebViewAsync().ConfigureAwait(true);
            }
            catch (Exception ex)
            {
                ShowStartupFailure(ex);
            }
        }

        private async Task InitialiseWebViewAsync()
        {
            SetStatus("Starting the designer...");

            // WebView2 keeps a per-user profile on disk. Anchoring it under the local application
            // data folder keeps it out of Program Files, which matters on locked-down builds.
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Oliver4", "DataModelDesigner", "WebView2");

            Directory.CreateDirectory(userDataFolder);

            var options = new CoreWebView2EnvironmentOptions("--disable-features=msSmartScreenProtection");
            var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options)
                .ConfigureAwait(true);

            await _webView.EnsureCoreWebView2Async(environment).ConfigureAwait(true);

            var core = _webView.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreDevToolsEnabled = true;

            core.AddWebResourceRequestedFilter(AppOrigin + "*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnWebResourceRequested;
            core.WebMessageReceived += OnWebMessageReceived;
            core.NewWindowRequested += OnNewWindowRequested;
            core.NavigationCompleted += OnNavigationCompleted;

            core.Navigate(AppOrigin + "index.html");
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                // The canvas is served from resources compiled into this assembly, so a navigation
                // failure means the assembly is damaged or incomplete rather than that anything is
                // wrong with the network. Saying which of the two it is saves a long hunt.
                LogError("The canvas failed to load: " + e.WebErrorStatus);

                SetStatus(
                    "The designer could not load its canvas (" + e.WebErrorStatus + ")." +
                    Environment.NewLine + Environment.NewLine +
                    "The canvas is built into this plugin rather than fetched over the network, so " +
                    "this usually means the DLL is damaged or was only partly copied. Close " +
                    "XrmToolBox, copy Oliver4.DataModelDesigner.dll into the Plugins folder " +
                    "again, and unblock it with Unblock-File if it arrived by download or email.");

                _webView.Visible = false;
                return;
            }

            _webViewReady = true;
            _statusLabel.Visible = false;
            _webView.Visible = true;

            // Drained after the flag is set, so PostToWeb sends these on rather than re-queuing.
            var buffered = _pendingMessages.ToList();
            _pendingMessages.Clear();

            foreach (var held in buffered)
            {
                // XrmToolBox calls UpdateConnection before the canvas has loaded, so a connection
                // event is normally sitting in this queue already. Posting it as well as the fresh
                // one below would tell the canvas about the same connection twice, and the canvas
                // raises a toast every time it is told. The held one is dropped rather than the
                // fresh one because the fresh one is read from ConnectionDetail now.
                if (string.Equals(held.EventName, BridgeEvents.ConnectionChanged, StringComparison.Ordinal))
                    continue;

                PostToWeb(held.Json, held.EventName);
            }

            // After the drain, not before it: this is the current state of the connection, and it
            // is the one the canvas should end up holding.
            PostEvent(BridgeEvents.ConnectionChanged, Connection);
        }

        /// <summary>
        /// Serves the embedded web app. Any request to <see cref="AppOrigin"/> is answered from the
        /// assembly, so the tool works with no network access and nothing is written to disk.
        /// </summary>
        private void OnWebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try
            {
                var uri = new Uri(e.Request.Uri);
                var relativePath = uri.AbsolutePath.TrimStart('/');
                if (string.IsNullOrEmpty(relativePath)) relativePath = "index.html";

                var resourceName = ResourceRoot + relativePath.Replace('/', '.');
                var assembly = typeof(ModelDesignerControl).Assembly;

                using (var stream = assembly.GetManifestResourceStream(resourceName))
                {
                    if (stream == null)
                    {
                        e.Response = _webView.CoreWebView2.Environment.CreateWebResourceResponse(
                            null, 404, "Not Found", "Content-Type: text/plain");
                        return;
                    }

                    var buffer = new MemoryStream();
                    stream.CopyTo(buffer);
                    buffer.Position = 0;

                    var headers =
                        "Content-Type: " + MimeTypeFor(relativePath) + "\r\n" +
                        "Cache-Control: no-store\r\n" +
                        "X-Content-Type-Options: nosniff";

                    e.Response = _webView.CoreWebView2.Environment.CreateWebResourceResponse(
                        buffer, 200, "OK", headers);
                }
            }
            catch (Exception ex)
            {
                LogError("Failed to serve web resource: " + ex.Message);
                e.Response = _webView.CoreWebView2.Environment.CreateWebResourceResponse(
                    null, 500, "Server Error", "Content-Type: text/plain");
            }
        }

        /// <summary>External links open in the user's browser rather than inside the tool.</summary>
        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            OpenUrl(e.Uri);
        }

        private static string MimeTypeFor(string path)
        {
            var extension = Path.GetExtension(path)?.ToLowerInvariant();
            switch (extension)
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".woff2": return "font/woff2";
                default: return "application/octet-stream";
            }
        }

        // ------------------------------------------------------------------
        // Bridge plumbing
        // ------------------------------------------------------------------

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            BridgeRequest request;
            try
            {
                // DateParseHandling.None. The payload is read as an untyped JObject, and
                // Newtonsoft's default rewrites any string whose whole value reads as an ISO-8601
                // date-time into a DateTime token - so a note or a description holding a timestamp
                // would come back reformatted, and a save would write the damaged value to disk.
                request = JsonConvert.DeserializeObject<BridgeRequest>(
                    e.TryGetWebMessageAsString(),
                    new JsonSerializerSettings { DateParseHandling = DateParseHandling.None });
            }
            catch (Exception ex)
            {
                LogError("Unreadable message from the canvas: " + ex.Message);
                return;
            }

            if (request == null || string.IsNullOrEmpty(request.Id)) return;

            // Answered here and now, not queued behind the work it is cancelling. Everything below
            // runs on a thread-pool thread, and the requests the user most wants to stop are the
            // ones already occupying one - a deep relationship walk, a metadata load over a slow
            // link. Going through the same path would leave the cancellation waiting its turn.
            if (request.Method == BridgeMethods.CancelWork)
            {
                var targetId = request.Payload == null ? null : (string)request.Payload["requestId"];
                CancelWork(targetId);

                Respond(new BridgeResponse { Id = request.Id, Ok = true, Payload = new { cancelled = true } });
                return;
            }

            var cancellation = new CancellationTokenSource();

            // A metadata read only means anything for the environment it was started against, and
            // cancellation cannot be relied on to stop one: MetadataService.GetCatalogue is a
            // single blocking call no token can interrupt, and GetTables checks its token only at
            // the top of its loop, so both can come back complete after the user has switched
            // connection. Capturing the environment here lets the completion below refuse to hand
            // environment A's catalogue to a canvas now labelled environment B.
            //
            // Only the metadata readers are fenced. diagram.open, diagram.save and export.run sit
            // on a modal file dialog and can straddle a connection change quite legitimately, and
            // an export started before connecting has no environment to be fenced against.
            var startedAgainst = HostBridge.IsEnvironmentSensitive(request.Method)
                ? Connection.OrganizationId
                : null;

            lock (_workLock)
            {
                _inFlight[request.Id] = cancellation;
            }

            // The token is NOT passed to Task.Run. Task.Run with an already-cancelled
            // token completes the task without ever invoking the delegate - so the catch and the
            // finally below would not run, no BridgeResponse would be posted, and the canvas
            // promise for this request id would never settle. The progress overlay would sit there
            // for ever. Cancellation is honoured inside Handle, which is passed the token.
            Task.Run(() =>
            {
                try
                {
                    var payload = _bridge.Handle(request, cancellation.Token);

                    if (!string.IsNullOrEmpty(startedAgainst) &&
                        !string.Equals(startedAgainst, Connection.OrganizationId, StringComparison.OrdinalIgnoreCase))
                    {
                        // Not the word "Cancelled.": bridge.js treats that exact string as a user
                        // cancellation and every caller then returns silently, which would leave
                        // the user with a picker that closed and no idea why.
                        Respond(new BridgeResponse
                        {
                            Id = request.Id,
                            Ok = false,
                            Error =
                                "The XrmToolBox connection changed while this was reading metadata, " +
                                "so the answer describes the environment you have just left. It has " +
                                "been discarded rather than shown under the new environment's name. " +
                                "Try again now the new environment is connected."
                        });

                        return;
                    }

                    Respond(new BridgeResponse { Id = request.Id, Ok = true, Payload = payload });
                }
                catch (OperationCanceledException)
                {
                    Respond(new BridgeResponse { Id = request.Id, Ok = false, Error = "Cancelled." });
                }
                catch (Exception ex)
                {
                    LogError(request.Method + " failed: " + ex);
                    Respond(new BridgeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = ex.Message,
                        ErrorDetail = ex.ToString()
                    });
                }
                finally
                {
                    lock (_workLock)
                    {
                        _inFlight.Remove(request.Id);
                    }

                    cancellation.Dispose();
                    ProgressDone();
                }
            });
        }

        /// <summary>
        /// Cancels every request still running, not only the most recently started one, so a long
        /// relationship walk is stopped when the user switches connection.
        /// </summary>
        private void CancelAllWork()
        {
            CancelWork(null);
        }

        /// <summary>
        /// Cancels one request by id, or every request when the id is null or empty.
        ///
        /// Cancellation is a request, not a guarantee. Some of what these services do between
        /// checks is a single blocking metadata call that has to come back before the token is
        /// looked at again, so the canvas says the work is being stopped rather than that it has
        /// been, and keeps its overlay up until the host actually answers. The one thing this does
        /// guarantee is that the answer, when it comes, is a cancellation rather than a result:
        /// the finally block in OnWebMessageReceived always posts a response, so no promise on the
        /// canvas is left unsettled and no progress overlay is left up for ever.
        /// </summary>
        private void CancelWork(string requestId)
        {
            List<CancellationTokenSource> sources;

            lock (_workLock)
            {
                if (string.IsNullOrEmpty(requestId))
                {
                    sources = _inFlight.Values.ToList();
                }
                else
                {
                    CancellationTokenSource one;
                    sources = _inFlight.TryGetValue(requestId, out one)
                        ? new List<CancellationTokenSource> { one }
                        : new List<CancellationTokenSource>();
                }
            }

            foreach (var source in sources)
            {
                try { source.Cancel(); }
                catch (ObjectDisposedException) { /* it finished between the snapshot and here */ }
            }
        }

        private void Respond(BridgeResponse response)
        {
            PostToWeb(JsonConvert.SerializeObject(response, DiagramFile.SerializerSettings));
        }

        private void PostEvent(string name, object payload)
        {
            PostToWeb(JsonConvert.SerializeObject(
                new BridgeEvent { Event = name, Payload = payload }, DiagramFile.SerializerSettings), name);
        }

        private void PostToWeb(string json)
        {
            PostToWeb(json, null);
        }

        /// <summary>
        /// Posts to the canvas, or holds the message until there is a canvas to post to.
        /// </summary>
        /// <param name="eventName">
        /// The event this message carries, or null for a response to a request. Only used while
        /// the message is held: the flush needs to know what it is holding.
        /// </param>
        private void PostToWeb(string json, string eventName)
        {
            if (IsDisposed) return;

            if (InvokeRequired)
            {
                try
                {
                    BeginInvoke(new Action<string, string>(PostToWeb), json, eventName);
                }
                catch (InvalidOperationException)
                {
                    // The control went away while background work was in flight.
                }

                return;
            }

            if (!_webViewReady)
            {
                // Held rather than dropped: the canvas asks for settings and app info before
                // navigation completes, and a dropped answer leaves that promise unsettled for
                // ever. OnNavigationCompleted flushes these in order. Bounded, because a canvas
                // that fails to load never drains the queue.
                if (_pendingMessages.Count < MaxPendingMessages)
                    _pendingMessages.Add(new PendingMessage { Json = json, EventName = eventName });
                return;
            }

            if (_webView?.CoreWebView2 == null) return;

            try
            {
                _webView.CoreWebView2.PostWebMessageAsString(json);
            }
            catch (Exception ex)
            {
                LogWarning("Could not post to the canvas: " + ex.Message);
            }
        }

        // ------------------------------------------------------------------
        // IHostServices
        // ------------------------------------------------------------------

        MetadataService IHostServices.Metadata => _metadata;

        ToolSettings IHostServices.Settings => _settings;

        public ConnectionInfo Connection
        {
            get
            {
                var detail = ConnectionDetail;
                if (detail == null || Service == null)
                    return new ConnectionInfo { Connected = false };

                var url = detail.WebApplicationUrl ?? detail.OrganizationServiceUrl;
                string host = null;
                Uri parsed;
                if (!string.IsNullOrEmpty(url) && Uri.TryCreate(url, UriKind.Absolute, out parsed))
                    host = parsed.Host;

                return new ConnectionInfo
                {
                    Connected = true,
                    OrganizationFriendlyName = detail.OrganizationFriendlyName ?? detail.ConnectionName,
                    OrganizationId = detail.EnvironmentId ?? detail.OrganizationUrlName ?? host,
                    EnvironmentUrl = url,
                    Host = host,
                    UserName = detail.UserName,
                    OrganizationVersion = detail.OrganizationVersion
                };
            }
        }

        void IHostServices.SaveSettings()
        {
            try
            {
                SettingsManager.Instance.Save(typeof(ModelDesignerControl), _settings);
            }
            catch (Exception ex)
            {
                LogWarning("Could not save settings: " + ex.Message);
            }
        }

        public void ReportProgress(string message, int percent)
        {
            // Work can still be in flight after the tool tab has been closed, and the status bar
            // belongs to XrmToolBox rather than to this tool - so progress text from a dead tab
            // would land on top of whatever the user switched to.
            if (IsDisposed) return;

            // StatusBarMessageEventArgs throws for anything outside 0-100, and a progress
            // callback is the last place that should be able to take the tool down.
            var bounded = Math.Max(0, Math.Min(100, percent));

            PostEvent(BridgeEvents.Progress, new { message, percent = bounded });
            SendMessageToStatusBar?.Invoke(this, new StatusBarMessageEventArgs(bounded, message));
        }

        public void ProgressDone()
        {
            // Same as ReportProgress: a clear posted after the tab has gone wipes a message the
            // tool the user moved to had put there.
            if (IsDisposed) return;

            PostEvent(BridgeEvents.ProgressDone, null);
            SendMessageToStatusBar?.Invoke(this, new StatusBarMessageEventArgs(string.Empty));
        }

        private void OnMetadataProgress(object sender, MetadataProgressEventArgs e)
        {
            ReportProgress(e.Message, e.Percent);
        }

        public string PromptSaveFile(string filter, string defaultFileName, string initialDirectory)
        {
            return OnUiThread(() =>
            {
                using (var dialog = new SaveFileDialog())
                {
                    dialog.Filter = filter;
                    dialog.FileName = defaultFileName;
                    dialog.OverwritePrompt = true;
                    dialog.AddExtension = true;

                    if (!string.IsNullOrEmpty(initialDirectory) && Directory.Exists(initialDirectory))
                        dialog.InitialDirectory = initialDirectory;

                    return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileName : null;
                }
            });
        }

        public string PromptOpenFile(string filter, string initialDirectory)
        {
            return OnUiThread(() =>
            {
                using (var dialog = new OpenFileDialog())
                {
                    dialog.Filter = filter;
                    dialog.CheckFileExists = true;

                    if (!string.IsNullOrEmpty(initialDirectory) && Directory.Exists(initialDirectory))
                        dialog.InitialDirectory = initialDirectory;

                    return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileName : null;
                }
            });
        }

        public void ShowMessage(string level, string text)
        {
            OnUiThread<object>(() =>
            {
                var icon = level == "error" ? MessageBoxIcon.Error
                    : level == "warning" ? MessageBoxIcon.Warning
                    : MessageBoxIcon.Information;

                MessageBox.Show(this, text, PluginInfo.ToolName, MessageBoxButtons.OK, icon);
                return null;
            });
        }

        public bool Confirm(string caption, string text)
        {
            return OnUiThread(() => MessageBox.Show(
                this, text, caption, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes);
        }

        public void OpenUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return;

            Uri parsed;
            if (!Uri.TryCreate(url, UriKind.Absolute, out parsed)) return;
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return;

            try
            {
                Process.Start(parsed.AbsoluteUri);
            }
            catch (Exception ex)
            {
                LogWarning("Could not open " + url + ": " + ex.Message);
            }
        }

        public void SetDirty(bool dirty, string title)
        {
            _isDirty = dirty;

            OnUiThread<object>(() =>
            {
                var name = string.IsNullOrWhiteSpace(title) ? PluginInfo.ToolName : title;
                ToolName = dirty ? name + " *" : name;
                return null;
            });
        }

        private T OnUiThread<T>(Func<T> action)
        {
            if (!InvokeRequired) return action();

            try
            {
                return (T)Invoke(action);
            }
            catch (InvalidOperationException)
            {
                return default(T);
            }
        }

        // ------------------------------------------------------------------
        // Fallback UI
        // ------------------------------------------------------------------

        private void SetStatus(string text)
        {
            if (_statusLabel == null) return;
            _statusLabel.Text = text;
            _statusLabel.Visible = true;
        }

        private void ShowStartupFailure(Exception ex)
        {
            LogError("The designer could not start: " + ex);

            var message = new StringBuilder();
            message.AppendLine("Oliver4 Data Model Designer could not start.");
            message.AppendLine();
            message.AppendLine(ex.Message);
            message.AppendLine();

            // Three failures account for nearly every case, and they need different fixes. Naming
            // the likely one saves the user working out which from a WebView2 HRESULT.
            var text = ex.ToString();

            if (text.IndexOf("WebView2", StringComparison.OrdinalIgnoreCase) >= 0 ||
                text.IndexOf("Loader", StringComparison.OrdinalIgnoreCase) >= 0 ||
                ex is DllNotFoundException)
            {
                message.AppendLine("This looks like a missing WebView2 runtime. The canvas is rendered by");
                message.AppendLine("Microsoft Edge WebView2, which ships with Windows 11 and with XrmToolBox");
                message.AppendLine("itself. Install the Microsoft Edge WebView2 Evergreen Runtime and restart");
                message.AppendLine("XrmToolBox.");
            }
            else if (ex is UnauthorizedAccessException || ex is IOException)
            {
                message.AppendLine("This looks like a permissions problem creating the WebView2 profile folder");
                message.AppendLine("under your local application data. If this machine is locked down, ask for");
                message.AppendLine("write access to:");
                message.AppendLine();
                message.AppendLine(Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Oliver4", "DataModelDesigner", "WebView2"));
            }
            else
            {
                message.AppendLine("The full error has been written to the XrmToolBox log, at");
                message.AppendLine("%APPDATA%\\MscrmTools\\XrmToolBox\\Logs.");
            }

            SetStatus(message.ToString());
            if (_webView != null) _webView.Visible = false;
        }
    }
}
