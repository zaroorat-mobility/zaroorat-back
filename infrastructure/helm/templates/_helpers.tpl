{{/* Chart name, overridable. */}}
{{- define "zaroorat-backend.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name. Truncated at 63 chars because some Kubernetes name
fields are limited to that by the DNS label spec.
*/}}
{{- define "zaroorat-backend.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "zaroorat-backend.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Selector labels — immutable; never add anything version-dependent here. */}}
{{- define "zaroorat-backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "zaroorat-backend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "zaroorat-backend.labels" -}}
helm.sh/chart: {{ include "zaroorat-backend.chart" . }}
{{ include "zaroorat-backend.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: zaroorat
{{- end -}}

{{- define "zaroorat-backend.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "zaroorat-backend.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Resolve the image reference. Digest wins over tag: the deploy workflows pass
--set image.digest so the running revision is immutable and rollbacks are exact.
Fails loudly rather than silently deploying :latest.
*/}}
{{- define "zaroorat-backend.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else if .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- else -}}
{{- fail "Set image.digest (preferred) or image.tag — refusing to deploy an unpinned image." -}}
{{- end -}}
{{- end -}}
