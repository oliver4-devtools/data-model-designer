using System.ComponentModel.Composition;
using XrmToolBox.Extensibility;
using XrmToolBox.Extensibility.Interfaces;

namespace Oliver4.DataModelDesigner
{
    /// <summary>
    /// Registration shim that XrmToolBox discovers through MEF. The real tool is
    /// <see cref="ModelDesignerControl"/>.
    /// </summary>
    [Export(typeof(IXrmToolBoxPlugin)),
     ExportMetadata("Name", "Oliver4 Data Model Designer"),
     ExportMetadata("Description",
         "Explore, design and document a Dataverse data model. Build focused ERDs from a solution, " +
         "selected tables or a relationship traversal; inspect cascade behaviour; add proposed, external " +
         "and deprecated objects alongside the current model; save an editable diagram and refresh it later."),
     ExportMetadata("SmallImageBase64", PluginIcons.Small),
     ExportMetadata("BigImageBase64", PluginIcons.Big),
     ExportMetadata("BackgroundColor", "White"),
     ExportMetadata("PrimaryFontColor", "#101725"),
     ExportMetadata("SecondaryFontColor", "#5b6577")]
    public class Plugin : PluginBase
    {
        public override IXrmToolBoxPluginControl GetControl()
        {
            return new ModelDesignerControl();
        }
    }
}
