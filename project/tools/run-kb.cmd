@echo off
REM KB pipeline: extract keywords from group chats, search bili/weibo/xhs, learn names, archive locally.
setlocal
set "WS=%~dp0.."
set "NODE=node"
cd /d "%WS%"
"%NODE%" tools\chat-keywords.mjs --limit 5 >> "%WS%\tools\kb-pipeline.log" 2>&1
"%NODE%" tools\kb-fetch.mjs --pending --limit 2 --per 2 >> "%WS%\tools\kb-pipeline.log" 2>&1
"%NODE%" tools\group-address.mjs >> "%WS%\tools\kb-pipeline.log" 2>&1
