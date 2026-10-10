# Discover native dialogs without walking unrelated UI Automation providers.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PortcoveNativeWindows {
    public class EditObservation {
        public int control_id;
        public int parent_id;
        public string parent_class;
        public IntPtr handle;
    }
    private delegate bool Visitor(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor visitor, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, Visitor visitor, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowStyle(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")] private static extern IntPtr SendText(IntPtr window, uint message, UIntPtr parameter, string text, uint flags, uint timeout, out UIntPtr result);
    private static bool MatchesFolderEdit(IntPtr window, IntPtr edit, int process) {
        uint actual;
        GetWindowThreadProcessId(edit, out actual);
        return edit != IntPtr.Zero && IsWindow(edit) && actual == process && Class(edit) == "Edit" &&
            GetParent(edit) == window && GetDlgCtrlID(edit) == 1152 && IsWindowEnabled(edit) &&
            (GetWindowStyle(edit, -16) & 0x0800) == 0;
    }
    public static void SetFolderText(IntPtr window, int process, string title, string value) {
        if (!Matches(window, process, title) || Class(window) != "#32770" || !IsWindowEnabled(window))
            throw new InvalidOperationException("Exact owned folder dialog changed.");
        var edit = GetDlgItem(window, 1152);
        if (!MatchesFolderEdit(window, edit, process))
            throw new InvalidOperationException("Exact owned folder textbox absent.");
        if (!Matches(window, process, title) || Class(window) != "#32770" || !IsWindowEnabled(window) || GetDlgItem(window, 1152) != edit ||
            !MatchesFolderEdit(window, edit, process))
            throw new InvalidOperationException("Exact owned folder textbox changed.");
        UIntPtr result;
        if (SendText(edit, 0x000C, UIntPtr.Zero, value, 0x0022, 5000, out result) == IntPtr.Zero || result == UIntPtr.Zero)
            throw new InvalidOperationException("Owned folder text input failed or timed out.");
    }
    private static string Class(IntPtr window) {
        var name = new StringBuilder(256);
        GetClassName(window, name, name.Capacity);
        return name.ToString();
    }
    public static EditObservation[] InspectEdits(IntPtr window, int process, string title) {
        if (!Matches(window, process, title)) throw new InvalidOperationException("Owned picker changed.");
        var edits = new List<EditObservation>();
        int count = 0;
        bool exceeded = false;
        Visitor visit = (child, state) => {
            if (++count > 4096) { exceeded = true; return false; }
            uint actual;
            GetWindowThreadProcessId(child, out actual);
            if (actual == process && Class(child) == "Edit") {
                var parent = GetParent(child);
                var parentClass = Class(parent);
                edits.Add(new EditObservation { handle = child, control_id = GetDlgCtrlID(child), parent_id = GetDlgCtrlID(parent),
                    parent_class = parentClass == "ComboBox" || parentClass == "ComboBoxEx32" ? parentClass : "other" });
            }
            return true;
        };
        EnumChildWindows(window, visit, IntPtr.Zero);
        if (exceeded || edits.Count > 8) throw new InvalidOperationException("Owned picker inspection exceeded its bound.");
        if (!Matches(window, process, title)) throw new InvalidOperationException("Owned picker changed.");
        return edits.ToArray();
    }
    public static bool Matches(IntPtr window, int process, string title) {
        uint actual;
        GetWindowThreadProcessId(window, out actual);
        if (!IsWindow(window) || actual != process) return false;
        var text = new StringBuilder(512);
        GetWindowText(window, text, text.Capacity);
        return String.Equals(text.ToString(), title, StringComparison.Ordinal);
    }
    public static IntPtr[] Find(int process, string title) {
        var roots = new List<IntPtr>();
        var matches = new HashSet<IntPtr>();
        int count = 0;
        bool exceeded = false;
        Visitor root = (window, state) => {
            if (++count > 4096) { exceeded = true; return false; }
            uint actual;
            GetWindowThreadProcessId(window, out actual);
            if (actual == process) {
                roots.Add(window);
                if (Matches(window, process, title)) matches.Add(window);
            }
            return true;
        };
        if (!EnumWindows(root, IntPtr.Zero) && !exceeded)
            throw new InvalidOperationException("Native window enumeration failed.");
        Visitor child = (window, state) => {
            if (++count > 4096) { exceeded = true; return false; }
            if (Matches(window, process, title)) matches.Add(window);
            return true;
        };
        foreach (var parent in roots) {
            if (exceeded) break;
            EnumChildWindows(parent, child, IntPtr.Zero);
        }
        if (exceeded) throw new InvalidOperationException("Native window enumeration exceeded its bound.");
        var result = new IntPtr[matches.Count];
        matches.CopyTo(result);
        return result;
    }
}
'@

function Get-NativePickerHandles { [PortcoveNativeWindows]::Find($applicationId, $Title) }
function Get-NativePickerElement([IntPtr]$Handle) { [System.Windows.Automation.AutomationElement]::FromHandle($Handle) }
function Test-NativePickerWindow([IntPtr]$Handle) { [PortcoveNativeWindows]::Matches($Handle, $applicationId, $Title) }
function Set-NativeFolderText($Window, [string]$Value) {
    Assert-ExactConfirmationWindow $Window
    [PortcoveNativeWindows]::SetFolderText([IntPtr]$Window.Current.NativeWindowHandle, $applicationId, $Title, $Value)
}
function Get-NativePickerEditEvidence($Window) {
    foreach ($edit in [PortcoveNativeWindows]::InspectEdits([IntPtr]$Window.Current.NativeWindowHandle, $applicationId, $Title)) {
        $type = 0; $owned = $null; $available = $null
        try {
            $element = Get-NativePickerElement $edit.handle
            $type = $element.Current.ControlType.Id
            $owned = ($element.Current.ProcessId -eq $applicationId)
            $pattern = $null
            $available = [bool]$element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
        } catch { $null = $_ }
        [pscustomobject]@{ control_id = $edit.control_id; parent_id = $edit.parent_id; parent_class = $edit.parent_class
            uia_control_type = $type; owned = $owned; value_pattern = $available }
    }
}

function Assert-ExactConfirmationWindow($Window) {
    Assert-LiveApplication
    if (-not $DirectoryPath) { return }
    if (-not (Test-NativePickerWindow ([IntPtr]$Window.Current.NativeWindowHandle)) -or
        $Window.Current.ProcessId -ne $applicationId -or $Window.Current.Name -cne $Title -or
        $Window.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
        throw 'Exact owned native window identity changed; no input permitted.'
    }
}

function Get-OwnedLibraryPickerWindows {
    Assert-LiveApplication
    Write-ObservationProgress 'exact-root-discovery-start'
    $handles = @(Get-NativePickerHandles)
    Write-ObservationProgress 'exact-root-discovery-ready'
    foreach ($handle in $handles) {
        $candidate = Get-NativePickerElement $handle
        Assert-ExactConfirmationWindow $candidate
        $candidate
    }
}
