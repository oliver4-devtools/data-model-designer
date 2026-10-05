// Compile-verification stubs for XrmToolBox, WinForms and WebView2. Not shipped.
#pragma warning disable CS0067, CS0169, CS0649

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Xrm.Sdk;

// -------------------------------------------------------------- WinForms --

namespace System.Windows.Forms
{
    public enum DockStyle { None, Top, Bottom, Left, Right, Fill }
    public enum DialogResult { None, OK, Cancel, Abort, Retry, Ignore, Yes, No }
    public enum MessageBoxButtons { OK, OKCancel, YesNo, YesNoCancel }
    public enum MessageBoxIcon { None, Error, Question, Warning, Information }
    public enum MessageBoxDefaultButton { Button1, Button2, Button3 }
    public enum CloseReason { None, WindowsShutDown, MdiFormClosing, UserClosing, TaskManagerClosing, FormOwnerClosing, ApplicationExitCall }

    public struct Padding
    {
        public Padding(int all) { All = all; }
        public int All { get; set; }
    }

    public class Control : IDisposable
    {
        public string Name { get; set; }
        public DockStyle Dock { get; set; }
        public bool Visible { get; set; }
        public bool IsDisposed { get; set; }
        public bool InvokeRequired { get; }
        public System.Drawing.Color BackColor { get; set; }
        public System.Drawing.Color ForeColor { get; set; }
        public System.Drawing.Size Size { get; set; }
        public Padding Padding { get; set; }
        public string Text { get; set; }
        public ControlCollection Controls { get; } = new ControlCollection();
        public Form ParentForm { get; }

        public event EventHandler Load;

        public object Invoke(Delegate method) => null;
        public IAsyncResult BeginInvoke(Delegate method, params object[] args) => null;
        public void SuspendLayout() { }
        public void ResumeLayout(bool performLayout) { }
        public virtual void Dispose() { }
        protected virtual void Dispose(bool disposing) { }
    }

    public class ControlCollection : List<Control>
    {
        public new void Add(Control control) { }
        public IEnumerable<T> OfType<T>() => new List<T>();
    }

    public class Form : Control { }

    public class UserControl : Control { }

    public class Label : Control
    {
        public System.Drawing.ContentAlignment TextAlign { get; set; }
        public System.Drawing.Font Font { get; set; }
    }

    public class Panel : Control { }

    public class CommonDialog : IDisposable
    {
        public string Filter { get; set; }
        public string FileName { get; set; }
        public string InitialDirectory { get; set; }
        public bool AddExtension { get; set; }
        public DialogResult ShowDialog(Control owner) => DialogResult.Cancel;
        public void Dispose() { }
    }

    public class SaveFileDialog : CommonDialog { public bool OverwritePrompt { get; set; } }
    public class OpenFileDialog : CommonDialog { public bool CheckFileExists { get; set; } }

    public static class MessageBox
    {
        public static DialogResult Show(string text) => DialogResult.OK;
        public static DialogResult Show(string text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon) => DialogResult.OK;
        public static DialogResult Show(string text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon, MessageBoxDefaultButton defaultButton) => DialogResult.OK;
        public static DialogResult Show(Control owner, string text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon) => DialogResult.OK;
        public static DialogResult Show(Control owner, string text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon, MessageBoxDefaultButton defaultButton) => DialogResult.OK;
    }
}

namespace System.Drawing
{
    public enum ContentAlignment
    {
        TopLeft, TopCenter, TopRight,
        MiddleLeft, MiddleCenter, MiddleRight,
        BottomLeft, BottomCenter, BottomRight
    }

    public class Font
    {
        public Font(string familyName, float emSize) { }
    }

    public class Icon { }
    public class Image { }
}

// ------------------------------------------------------------- WebView2 --

namespace Microsoft.Web.WebView2.Core
{
    public class CoreWebView2EnvironmentOptions
    {
        public CoreWebView2EnvironmentOptions() { }
        public CoreWebView2EnvironmentOptions(string additionalBrowserArguments) { }
    }

    public enum CoreWebView2WebResourceContext { All, Document, Stylesheet, Image, Media, Font, Script, XmlHttpRequest, Fetch, Other }
    public enum CoreWebView2WebErrorStatus { Unknown, ConnectionAborted, Disconnected }

    public class CoreWebView2Environment
    {
        public static Task<CoreWebView2Environment> CreateAsync(string browserExecutableFolder, string userDataFolder, CoreWebView2EnvironmentOptions options)
            => Task.FromResult(new CoreWebView2Environment());

        public CoreWebView2WebResourceResponse CreateWebResourceResponse(System.IO.Stream content, int statusCode, string reasonPhrase, string headers)
            => new CoreWebView2WebResourceResponse();
    }

    public class CoreWebView2WebResourceResponse { }

    public class CoreWebView2WebResourceRequest { public string Uri { get; set; } }

    public class CoreWebView2WebResourceRequestedEventArgs : EventArgs
    {
        public CoreWebView2WebResourceRequest Request { get; set; }
        public CoreWebView2WebResourceResponse Response { get; set; }
    }

    public class CoreWebView2WebMessageReceivedEventArgs : EventArgs
    {
        public string WebMessageAsJson { get; set; }
        public string TryGetWebMessageAsString() => string.Empty;
    }

    public class CoreWebView2NewWindowRequestedEventArgs : EventArgs
    {
        public string Uri { get; set; }
        public bool Handled { get; set; }
    }

    public class CoreWebView2NavigationCompletedEventArgs : EventArgs
    {
        public bool IsSuccess { get; set; }
        public CoreWebView2WebErrorStatus WebErrorStatus { get; set; }
    }

    public class CoreWebView2Settings
    {
        public bool AreDefaultContextMenusEnabled { get; set; }
        public bool IsStatusBarEnabled { get; set; }
        public bool AreBrowserAcceleratorKeysEnabled { get; set; }
        public bool IsPasswordAutosaveEnabled { get; set; }
        public bool IsGeneralAutofillEnabled { get; set; }
        public bool IsZoomControlEnabled { get; set; }
        public bool AreDevToolsEnabled { get; set; }
    }

    public class CoreWebView2
    {
        public CoreWebView2Settings Settings { get; } = new CoreWebView2Settings();
        public CoreWebView2Environment Environment { get; } = new CoreWebView2Environment();

        public event EventHandler<CoreWebView2WebResourceRequestedEventArgs> WebResourceRequested;
        public event EventHandler<CoreWebView2WebMessageReceivedEventArgs> WebMessageReceived;
        public event EventHandler<CoreWebView2NewWindowRequestedEventArgs> NewWindowRequested;
        public event EventHandler<CoreWebView2NavigationCompletedEventArgs> NavigationCompleted;

        public void AddWebResourceRequestedFilter(string uri, CoreWebView2WebResourceContext resourceContext) { }
        public void Navigate(string uri) { }
        public void PostWebMessageAsString(string webMessageAsString) { }
    }
}

namespace Microsoft.Web.WebView2.WinForms
{
    using Microsoft.Web.WebView2.Core;

    public class WebView2 : System.Windows.Forms.Control
    {
        public CoreWebView2 CoreWebView2 { get; }
        public System.Drawing.Color DefaultBackgroundColor { get; set; }
        public Task EnsureCoreWebView2Async(CoreWebView2Environment environment) => Task.CompletedTask;
    }
}

// ----------------------------------------------------------- XrmToolBox --

namespace McTools.Xrm.Connection
{
    public class ConnectionDetail
    {
        public string ConnectionName { get; set; }
        public string OrganizationFriendlyName { get; set; }
        public string OrganizationServiceUrl { get; set; }
        public string OrganizationUrlName { get; set; }
        public string OrganizationVersion { get; set; }
        public string WebApplicationUrl { get; set; }
        public string EnvironmentId { get; set; }
        public string UserName { get; set; }
        public string ServerName { get; set; }
    }
}

namespace XrmToolBox.Extensibility.Interfaces
{
    public interface IXrmToolBoxPlugin { }
    public interface IXrmToolBoxPluginControl { }
    public interface INoConnectionRequired { }
    public interface IStatusBarMessenger
    {
        event EventHandler<XrmToolBox.Extensibility.Args.StatusBarMessageEventArgs> SendMessageToStatusBar;
    }
    public interface IGitHubPlugin { string RepositoryName { get; } string UserName { get; } }
    public interface IHelpPlugin { string HelpUrl { get; } }
    public interface IAboutPlugin { void ShowAboutDialog(); }
    public interface IPayPalPlugin { string DonationDescription { get; } string EmailAccount { get; } }
}

namespace XrmToolBox.Extensibility.Args
{
    public class StatusBarMessageEventArgs : EventArgs
    {
        public StatusBarMessageEventArgs(string message) { }
        public StatusBarMessageEventArgs(int progress, string message) { }
    }
}

namespace XrmToolBox.Extensibility
{
    using XrmToolBox.Extensibility.Interfaces;
    using McTools.Xrm.Connection;

    public enum ToolBoxCloseReason { CloseCurrent, CloseAll, CloseAllExceptActive, PluginRequest, ApplicationExit }

    public class PluginCloseInfo
    {
        public bool Cancel { get; set; }
        public System.Windows.Forms.CloseReason FormReason { get; set; }
        public ToolBoxCloseReason ToolBoxReason { get; set; }
        public bool Silent { get; set; }
    }

    public abstract class PluginBase : IXrmToolBoxPlugin
    {
        public abstract IXrmToolBoxPluginControl GetControl();
    }

    public class PluginControlBase : System.Windows.Forms.UserControl, IXrmToolBoxPluginControl
    {
        public ConnectionDetail ConnectionDetail { get; set; }
        public IOrganizationService Service { get; private set; }
        public string ToolName { get; set; }
        public System.Drawing.Icon PluginIcon { get; set; }
        public System.Drawing.Image TabIcon { get; set; }

        public virtual void UpdateConnection(IOrganizationService newService, ConnectionDetail detail, string actionName, object parameter) { }
        public virtual void ClosingPlugin(PluginCloseInfo info) { }
        public void LogError(string message, params object[] args) { }
        public void LogInfo(string message, params object[] args) { }
        public void LogWarning(string message, params object[] args) { }
        public void ExecuteMethod(Action action) { }
        public void SetWorkingMessage(string message, int width = 340, int height = 150) { }
        public void CloseTool() { }
    }

    public class SettingsManager
    {
        public static SettingsManager Instance { get; } = new SettingsManager();
        public void Save(Type pluginType, object settings) { }
        public bool TryLoad<T>(Type pluginType, out T settings) { settings = default(T); return false; }
    }
}

// ------------------------------------------------------ MEF (verification) --

namespace System.ComponentModel.Composition
{
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Field, AllowMultiple = true)]
    public class ExportAttribute : Attribute
    {
        public ExportAttribute() { }
        public ExportAttribute(Type contractType) { }
        public ExportAttribute(string contractName) { }
    }

    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Field, AllowMultiple = true)]
    public class ExportMetadataAttribute : Attribute
    {
        public ExportMetadataAttribute(string name, object value) { }
    }
}
