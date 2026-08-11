@echo off
REM ===================================================================
REM  Deck Portal — upload follower portraits & Spell Deck icons from a
REM  phone or any PC on the LAN, while Skyrim is running.
REM
REM  Copy this whole folder to the portal folder and double-click.
REM  Then open http://<this-pc-lan-ip>:8090 on your phone.
REM
REM  Full setup notes: RUNBOOK.md next to this file.
REM ===================================================================
title Deck Portal - http://<this-pc-lan-ip>:8090
node "%~dp0server.js"
echo.
echo Deck Portal stopped. Press any key to close.
pause > nul
