@echo off
REM Mile 1 bridge for ComfyUI. Put this file, comfy-bridge.js and your exported workflow.json in one folder.
REM 1. Change the token below to a long secret (the same value as COMFYUI_TOKEN on Render).
REM 2. Start ComfyUI first, then double-click this file. Keep the window open while you make reels.
set BRIDGE_TOKEN=change-this-to-a-long-secret-1234567890
node "%~dp0comfy-bridge.js"
pause
