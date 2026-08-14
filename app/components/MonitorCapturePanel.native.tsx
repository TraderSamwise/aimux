import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image, Platform, View } from "react-native";
import { Camera as CameraIcon, Mic, MicOff, Repeat, Square } from "lucide-react-native";
import {
  CameraView,
  useCameraPermissions,
  type CameraCapturedPicture,
  type CameraType,
} from "expo-camera";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useAtomValue } from "jotai";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import {
  estimateBase64DecodedBytes,
  MONITOR_IMAGE_MIME_TYPE,
  MONITOR_IMAGE_QUALITY,
  MONITOR_SPEECH_CONTEXT,
  monitorFrameFilename,
  type MonitorFrameSample,
} from "@/lib/monitor-capture";
import { monitorSettingsAtom } from "@/stores/settings";

function capturesCamera(mode: string) {
  return mode === "camera" || mode === "camera-audio";
}

function capturesAudio(mode: string) {
  return mode === "audio" || mode === "camera-audio";
}

async function supportsRequestedOnDeviceLocale(locale: string): Promise<boolean> {
  if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) return false;
  if (Platform.OS === "ios") return true;
  try {
    const supported = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    return supported.installedLocales.includes(locale);
  } catch {
    return false;
  }
}

export function MonitorCapturePanel({
  onFrameCaptured,
}: {
  onFrameCaptured?: (sample: MonitorFrameSample) => void;
}) {
  const settings = useAtomValue(monitorSettingsAtom);
  const cameraRef = useRef<CameraView | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("back");
  const [running, setRunning] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [lastFrame, setLastFrame] = useState<MonitorFrameSample | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [speechText, setSpeechText] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);

  useSpeechRecognitionEvent("start", () => setRecognizing(true));
  useSpeechRecognitionEvent("end", () => setRecognizing(false));
  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results
      .map((result) => result.transcript)
      .filter(Boolean)
      .join(" ")
      .trim();
    if (transcript) setSpeechText(transcript);
  });
  useSpeechRecognitionEvent("error", (event) => {
    setRecognizing(false);
    setSpeechError(event.message || event.error);
  });

  const captureNow = useCallback(async () => {
    if (!capturesCamera(settings.captureMode) || !cameraPermission?.granted) return;
    const camera = cameraRef.current;
    if (!camera || capturing) return;
    setCapturing(true);
    try {
      const picture: CameraCapturedPicture = await camera.takePictureAsync({
        base64: true,
        exif: false,
        quality: MONITOR_IMAGE_QUALITY,
        shutterSound: false,
      });
      if (!picture.base64) return;
      const capturedAt = new Date().toISOString();
      const sample: MonitorFrameSample = {
        filename: monitorFrameFilename(capturedAt),
        mimeType: MONITOR_IMAGE_MIME_TYPE,
        dataBase64: picture.base64,
        capturedAt,
        uri: picture.uri,
        width: picture.width,
        height: picture.height,
        sizeBytes: estimateBase64DecodedBytes(picture.base64),
      };
      setLastFrame(sample);
      setFrameCount((current) => current + 1);
      onFrameCaptured?.(sample);
    } finally {
      setCapturing(false);
    }
  }, [cameraPermission?.granted, capturing, onFrameCaptured, settings.captureMode]);

  const startSpeech = useCallback(async () => {
    if (!settings.speechToText || !capturesAudio(settings.captureMode)) return;
    setSpeechError(null);
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        setSpeechError("Speech recognition is unavailable on this device.");
        return;
      }
      if (
        settings.speechOnDeviceOnly &&
        !(await supportsRequestedOnDeviceLocale(settings.speechLanguage))
      ) {
        setSpeechError(`On-device speech is unavailable for ${settings.speechLanguage}.`);
        return;
      }
      const permissions = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permissions.granted) {
        setSpeechError("Speech permission denied.");
        return;
      }
      ExpoSpeechRecognitionModule.start({
        lang: settings.speechLanguage,
        interimResults: settings.speechInterimResults,
        continuous: true,
        requiresOnDeviceRecognition: settings.speechOnDeviceOnly,
        addsPunctuation: true,
        contextualStrings: [...MONITOR_SPEECH_CONTEXT],
        iosTaskHint: "dictation",
      });
    } catch (err) {
      setSpeechError(err instanceof Error ? err.message : String(err));
      return;
    }
  }, [settings]);

  const stopSpeech = useCallback(() => {
    if (!recognizing) return;
    ExpoSpeechRecognitionModule.stop();
  }, [recognizing]);

  const start = useCallback(async () => {
    if (capturesCamera(settings.captureMode) && !cameraPermission?.granted) {
      const nextPermission = await requestCameraPermission();
      if (!nextPermission.granted) return;
    }
    setRunning(true);
    await startSpeech();
    setTimeout(() => {
      void captureNow();
    }, 250);
  }, [
    cameraPermission?.granted,
    captureNow,
    requestCameraPermission,
    settings.captureMode,
    startSpeech,
  ]);

  const stop = useCallback(() => {
    setRunning(false);
    stopSpeech();
  }, [stopSpeech]);

  useEffect(() => {
    if (!running || !capturesCamera(settings.captureMode)) return;
    const id = setInterval(() => {
      void captureNow();
    }, settings.intervalSeconds * 1000);
    return () => clearInterval(id);
  }, [captureNow, running, settings.captureMode, settings.intervalSeconds]);

  useEffect(() => {
    if (!running || !recognizing) return;
    if (settings.speechToText && capturesAudio(settings.captureMode)) return;
    ExpoSpeechRecognitionModule.stop();
  }, [recognizing, running, settings.captureMode, settings.speechToText]);

  useEffect(() => {
    return () => {
      ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  const cameraReady = !capturesCamera(settings.captureMode) || cameraPermission?.granted;
  const status = running
    ? capturing
      ? "Capturing"
      : recognizing
        ? "Listening"
        : "Running"
    : "Stopped";

  return (
    <Card className="overflow-hidden rounded-lg">
      <View className="border-b border-border px-5 py-4 md:flex-row md:items-center md:justify-between">
        <View className="min-w-0">
          <Text className="text-base font-semibold text-foreground">Live monitor</Text>
          <Text className="mt-1 text-sm text-muted-foreground">{status}</Text>
        </View>
        <View className="mt-3 flex-row gap-2 md:mt-0">
          <Button
            variant="outline"
            size="icon"
            accessibilityLabel="Switch camera"
            disabled={running || !capturesCamera(settings.captureMode)}
            onPress={() => setFacing((current) => (current === "back" ? "front" : "back"))}
          >
            <Repeat size={16} color="#fafafa" />
          </Button>
          <Button
            variant={running ? "destructive" : "default"}
            className="gap-2"
            onPress={running ? stop : start}
          >
            {running ? (
              <Square size={16} color="#fafafa" />
            ) : (
              <CameraIcon size={16} color="#0a0a0c" />
            )}
            <Text
              className={
                running
                  ? "text-sm font-semibold text-destructive-foreground"
                  : "text-sm font-semibold text-primary-foreground"
              }
            >
              {running ? "Stop" : cameraReady ? "Start" : "Allow camera"}
            </Text>
          </Button>
        </View>
      </View>

      <View className="gap-4 p-5 md:flex-row">
        <View className="min-w-0 flex-1">
          {capturesCamera(settings.captureMode) ? (
            <View className="aspect-[4/3] overflow-hidden rounded-lg border border-border bg-background">
              {cameraPermission?.granted ? (
                <CameraView
                  ref={cameraRef}
                  className="h-full w-full"
                  facing={facing}
                  mode="picture"
                />
              ) : lastFrame ? (
                <Image
                  source={{ uri: lastFrame.uri }}
                  className="h-full w-full"
                  resizeMode="cover"
                />
              ) : (
                <View className="h-full w-full items-center justify-center px-5">
                  <CameraIcon size={28} color="#71717a" />
                  <Text className="mt-3 text-center text-sm text-muted-foreground">
                    Camera permission required
                  </Text>
                </View>
              )}
            </View>
          ) : (
            <View className="aspect-[4/3] items-center justify-center rounded-lg border border-border bg-background px-5">
              <Mic size={28} color="#38bdf8" />
              <Text className="mt-3 text-center text-sm text-muted-foreground">
                Audio monitor active
              </Text>
            </View>
          )}
          <View className="mt-3 flex-row flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              label={capturing ? "Capturing..." : "Capture now"}
              disabled={
                !cameraPermission?.granted || capturing || !capturesCamera(settings.captureMode)
              }
              onPress={() => void captureNow()}
            />
            <View className="rounded-lg border border-border px-3 py-2">
              <Text className="text-xs text-muted-foreground">{frameCount} frames</Text>
            </View>
            <View className="rounded-lg border border-border px-3 py-2">
              <Text className="text-xs text-muted-foreground">
                {lastFrame ? `${Math.round(lastFrame.sizeBytes / 1024)} KB` : "No frame"}
              </Text>
            </View>
          </View>
        </View>

        <View className="min-w-0 flex-1">
          <View className="min-h-[180px] rounded-lg border border-border bg-background p-4">
            <View className="flex-row items-center gap-2">
              {recognizing ? (
                <Mic size={16} color="#38bdf8" />
              ) : (
                <MicOff size={16} color="#71717a" />
              )}
              <Text className="text-sm font-semibold text-foreground">Speech notes</Text>
            </View>
            <Text className="mt-3 text-sm leading-6 text-muted-foreground">
              {speechError ?? (speechText.trim() || "No speech transcript yet.")}
            </Text>
          </View>
          <View className="mt-3 flex-row flex-wrap gap-2">
            <View className="rounded-lg border border-border px-3 py-2">
              <Text className="text-xs text-muted-foreground">{settings.speechLanguage}</Text>
            </View>
            <View className="rounded-lg border border-border px-3 py-2">
              <Text className="text-xs text-muted-foreground">{settings.audioSampleRate} Hz</Text>
            </View>
            <View className="rounded-lg border border-border px-3 py-2">
              <Text className="text-xs text-muted-foreground">
                {settings.speechOnDeviceOnly ? "On-device" : "System default"}
              </Text>
            </View>
          </View>
        </View>
      </View>
    </Card>
  );
}
