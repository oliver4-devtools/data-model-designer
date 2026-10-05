using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

namespace Oliver4.DataModelDesigner
{
    partial class ModelDesignerControl
    {
        private System.ComponentModel.IContainer components = null;

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                components?.Dispose();

                if (_webView != null)
                {
                    if (_webView.CoreWebView2 != null)
                    {
                        _webView.CoreWebView2.WebResourceRequested -= OnWebResourceRequested;
                        _webView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
                        _webView.CoreWebView2.NewWindowRequested -= OnNewWindowRequested;
                        _webView.CoreWebView2.NavigationCompleted -= OnNavigationCompleted;
                    }

                    _webView.Dispose();
                    _webView = null;
                }

                if (_metadata != null)
                {
                    _metadata.Progress -= OnMetadataProgress;
                    _metadata = null;
                }

                // Cancel rather than dispose: a request still running holds its own token source
                // and disposes it in its finally block. Disposing them from here would race that,
                // and cancelling is what actually stops the work.
                CancelAllWork();
            }

            base.Dispose(disposing);
        }

        /// <summary>
        /// Built in code rather than through the forms designer: the whole surface is one web view,
        /// so a .resx and generated layout would add files without adding anything a maintainer needs.
        /// </summary>
        private void InitializeComponent()
        {
            components = new System.ComponentModel.Container();

            _statusLabel = new Label
            {
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Segoe UI", 9.75f),
                ForeColor = Color.FromArgb(91, 101, 119),
                BackColor = Color.White,
                Padding = new Padding(40),
                Text = "Starting the designer..."
            };

            _webView = new WebView2
            {
                Dock = DockStyle.Fill,
                Visible = false,
                DefaultBackgroundColor = Color.White
            };

            SuspendLayout();

            Controls.Add(_webView);
            Controls.Add(_statusLabel);

            BackColor = Color.White;
            Name = "ModelDesignerControl";
            Size = new Size(1200, 800);

            ResumeLayout(false);
        }
    }
}
