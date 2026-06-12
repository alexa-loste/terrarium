#!/usr/bin/env bash
# Mini-only: applies the ollama memory fixes at login and (re)starts Ollama so it picks them up.
# Run by the com.terrarium.ollama-env LaunchAgent. Harmless on machines without Ollama.
#
# OLLAMA_CONTEXT_LENGTH=4096 caps the KV-cache (deepseek-v2 defaults to a 32k window, which
# OOMs the 16GB Mini); OLLAMA_NUM_PARALLEL=1 serializes generation. Both must be set BEFORE
# Ollama launches, hence the quit/relaunch.
launchctl setenv OLLAMA_CONTEXT_LENGTH 4096
launchctl setenv OLLAMA_NUM_PARALLEL 1
sleep 5
/usr/bin/osascript -e 'quit app "Ollama"' 2>/dev/null || true
sleep 3
/usr/bin/open -a Ollama || true
