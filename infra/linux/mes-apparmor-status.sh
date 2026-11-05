#!/usr/bin/env bash

# Read all aa-status output before returning so pipefail observes the producer's
# exit status without grep -q closing the pipe early on a match.
mes_rootlesskit_profile_loaded() {
  aa-status | grep -F 'rootlesskit' >/dev/null
}
