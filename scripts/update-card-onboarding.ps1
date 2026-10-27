param([string]$BaseUrl = 'http://127.0.0.1:8000', [string]$Login = 'admin@example.local', [string]$Password = 'admin')
$ErrorActionPreference = 'Stop'
$pack = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '../content/card-onboarding.json') | ConvertFrom-Json
$auth = Invoke-RestMethod "$BaseUrl/api/auth/login" -Method Post -ContentType application/json -Body (@{email=$Login;password=$Password} | ConvertTo-Json)
$headers = @{Authorization="Bearer $($auth.token)"}
function Send($Path, $Body) {
    $Body.token = $auth.adminToken
    $json = $Body | ConvertTo-Json -Depth 60
    Invoke-RestMethod "$BaseUrl$Path" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
}
$data = Invoke-RestMethod "$BaseUrl/api/app-data" -Headers $headers
foreach ($module in $pack.modules) {
    $existingModule = $data.modules | Where-Object moduleId -eq $module.id | Select-Object -First 1
    if (-not $existingModule) { throw "Module missing: $($module.id)" }
    Send '/api/module/update' @{moduleId=$module.id;courseId=$pack.courseId;title=$module.title;description=$module.description;moduleType=$module.type;maxAttempts=3;passingScore=70;reviewMode='mixed';lockAfterSubmit=$false;isTimed=$false;displayOrder=$existingModule.displayOrder;status='active'} | Out-Null
    $order = 0
    foreach ($activity in $module.activities) {
        $order++
        $existing = $data.activities | Where-Object { $_.courseId -eq $pack.courseId -and $_.activityId -eq $activity.id } | Select-Object -First 1
        if (-not $existing) {
            $existing = $data.activities | Where-Object { $_.moduleId -eq $module.id -and $_.title -eq $activity.title } | Select-Object -First 1
        }
        if (-not $existing -and $activity.type -ne 'html_content') {
            if ($activity.type -eq 'worksheet') {
                $worksheets = @($data.activities | Where-Object { $_.moduleId -eq $module.id -and $_.activityType -eq 'worksheet' })
                if ($worksheets.Count -eq 1) { $existing = $worksheets[0] }
            }
        }
        if (-not $existing -and $activity.type -ne 'html_content') {
            $matches = @($data.activities | Where-Object { $_.courseId -eq $pack.courseId -and $_.title -eq $activity.title })
            if ($matches.Count -eq 1) { $existing = $matches[0] }
        }
        $body = @{moduleId=$module.id;activityType=$activity.type;title=$activity.title;content=$activity.content;configJson=$activity.config;validationJson=$activity.validation;points=$activity.points;manualReviewRequired=[bool]$activity.manual;displayOrder=$order;status='active'}
        if ($existing) {
            $body.activityId = $existing.activityId
            Send '/api/activity/update' $body | Out-Null
        } else { Send '/api/activity/create' $body | Out-Null }
    }
}
# Retire only the six old duplicate submissions; preserve any submitted work.
foreach ($activity in $data.activities) {
    if ($activity.moduleId -eq 'mod_card_onboarding_deliverables' -and $activity.activityId -match '^act_card_onboarding_submission_[0-5]$' -and $activity.status -eq 'active') {
        Send '/api/activity/delete' @{activityId=$activity.activityId} | Out-Null
    }
}
# All remaining deliverables now live inside their numbered modules.
foreach ($retired in $pack.retiredActivities) {
    $old = $data.activities | Where-Object { $_.moduleId -eq $retired.moduleId -and ($_.activityId -eq $retired.id -or $_.title -eq $retired.title) } | Select-Object -First 1
    if ($old) { Send '/api/activity/delete' @{activityId=$old.activityId} | Out-Null }
}
if ($data.modules | Where-Object { $_.moduleId -eq 'mod_card_onboarding_deliverables' -and $_.status -eq 'active' }) {
    Send '/api/module/delete' @{moduleId='mod_card_onboarding_deliverables'} | Out-Null
}
$current = Invoke-RestMethod "$BaseUrl/api/app-data" -Headers $headers
foreach ($module in $pack.modules) {
    $active = @($current.activities | Where-Object moduleId -eq $module.id | Sort-Object displayOrder)
    $ordered = @()
    foreach ($activity in $module.activities) {
        $match = $active | Where-Object activityId -eq $activity.id | Select-Object -First 1
        if (-not $match) { $match = $active | Where-Object title -eq $activity.title | Select-Object -First 1 }
        if ($match) { $ordered += $match.activityId }
    }
    $ordered += @($active | Where-Object { $_.activityId -notin $ordered } | ForEach-Object activityId)
    Send '/api/activity/reorder' @{moduleId=$module.id;orderedIds=@($ordered)} | Out-Null
}
Write-Output 'Card onboarding content updated. Existing answers and attempts retained.'
