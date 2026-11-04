package main

// releaseSHA is supplied at build time by the OCI release workflow.
var releaseSHA = "unknown"

func validatedReleaseRevision(value string) string {
	if len(value) != 40 {
		return "unknown"
	}
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return "unknown"
		}
	}
	return value
}
