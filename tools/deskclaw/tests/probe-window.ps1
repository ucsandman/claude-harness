#Requires -Version 7
# A throwaway WinForms window this test suite owns start to finish. It exists so the
# read-side tests can assert on attributes (value=, toggle=, expanded=, enabled=false)
# against a REAL UI Automation tree without touching any window the user opened.
# Auto-closes after -Seconds so a wedged test never leaves a window on the desktop.
param([string]$Title = 'deskclaw probe', [int]$Seconds = 20, [switch]$Dropdown)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width = 440
$form.Height = 260
$form.StartPosition = 'CenterScreen'

$tb = New-Object System.Windows.Forms.TextBox
$tb.Text = 'deskclaw-value-probe'
$tb.Left = 12; $tb.Top = 16; $tb.Width = 380
$form.Controls.Add($tb)

$cb = New-Object System.Windows.Forms.CheckBox
$cb.Text = 'probe checkbox'; $cb.Checked = $true
$cb.Left = 12; $cb.Top = 56; $cb.Width = 220
$form.Controls.Add($cb)

$combo = New-Object System.Windows.Forms.ComboBox
$combo.DropDownStyle = 'DropDownList'
[void]$combo.Items.AddRange(@('alpha', 'beta', 'gamma'))
$combo.SelectedIndex = 0
$combo.Left = 12; $combo.Top = 96; $combo.Width = 220
$form.Controls.Add($combo)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'probe button'; $btn.Enabled = $false
$btn.Left = 12; $btn.Top = 136; $btn.Width = 140
$form.Controls.Add($btn)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1000, $Seconds * 1000)
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$form.Add_Shown({ $timer.Start(); if ($Dropdown) { $combo.DroppedDown = $true } })

[void]$form.ShowDialog()
