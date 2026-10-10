# Discover native dialogs without walking unrelated UI Automation providers.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PortcoveNativeWindows {
    private delegate bool Visitor(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor visitor, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, Visitor visitor, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
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
