import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Image,
  Platform,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Camera as CameraIcon, Mic, MicOff, Repeat, Square } from "lucide-react-native";
import {
  CameraView,
  useCameraPermissions,
  type CameraCapturedPicture,
  type CameraType,
} from "expo-camera";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useAtom } from "jotai";
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
  type MonitorSample,
  type MonitorCapturePanelProps,
} from "@/lib/monitor-capture";
import {
  MONITOR_CAMERA_MAX_ZOOM,
  MONITOR_CAMERA_MIN_ZOOM,
  monitorSettingsAtom,
  type MonitorCameraViewport,
} from "@/stores/settings";

function capturesCamera(mode: string) {
  return mode === "camera" || mode === "camera-audio";
}

function capturesAudio(mode: string) {
  return mode === "audio" || mode === "camera-audio";
}

interface PreviewLayout {
  height: number;
  width: number;
}

interface FocusGesture {
  distance: number | null;
  startTouches: { x: number; y: number };
  startViewport: MonitorCameraViewport;
  touchCount: number;
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
  deliveryEnabled = false,
  deliveryLabel,
  deliveryHint,
  startDisabled = false,
  textOnlyDelivery = false,
  onSampleCaptured,
}: MonitorCapturePanelProps = {}) {
  const [settings, setSettings] = useAtom(monitorSettingsAtom);
  const cameraRef = useRef<CameraView | null>(null);
  const lastDeliveredSpeechRef = useRef("");
  const viewportRef = useRef(settings.cameraViewport);
  const gestureRef = useRef<FocusGesture | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("back");
  const [viewport, setViewport] = useState(settings.cameraViewport);
  const [previewLayout, setPreviewLayout] = useState<PreviewLayout>({ height: 0, width: 0 });
  const [running, setRunning] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [deliveryCount, setDeliveryCount] = useState(0);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [lastFrame, setLastFrame] = useState<MonitorFrameSample | null>(null);
  const [cameraPreviewState, setCameraPreviewState] = useState<{
    error: string | null;
    key: string;
    ready: boolean;
  }>({ error: null, key: "", ready: false });
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

  const setLiveViewport = useCallback((next: MonitorCameraViewport) => {
    const normalized = normalizeViewport(next);
    viewportRef.current = normalized;
    setViewport(normalized);
  }, []);

  useEffect(() => {
    if (gestureRef.current) return;
    setLiveViewport(settings.cameraViewport);
  }, [setLiveViewport, settings.cameraViewport]);

  const persistViewport = useCallback(() => {
    const nextViewport = viewportRef.current;
    setSettings((current) => ({
      ...current,
      cameraViewport: nextViewport,
    }));
  }, [setSettings]);

  const deliverSample = useCallback(
    async (sample: MonitorSample) => {
      if (!deliveryEnabled || !onSampleCaptured) return;
      setDelivering(true);
      setDeliveryError(null);
      try {
        await onSampleCaptured(sample);
        setDeliveryCount((current) => current + 1);
        const transcript = sample.transcript?.trim();
        if (transcript) lastDeliveredSpeechRef.current = transcript;
      } catch (err) {
        setDeliveryError(err instanceof Error ? err.message : String(err));
      } finally {
        setDelivering(false);
      }
    },
    [deliveryEnabled, onSampleCaptured],
  );

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
      const focusedPicture = await cropPictureToViewport(picture, viewportRef.current);
      const capturedAt = new Date().toISOString();
      const sample: MonitorFrameSample = {
        filename: monitorFrameFilename(capturedAt),
        mimeType: MONITOR_IMAGE_MIME_TYPE,
        dataBase64: focusedPicture.base64,
        capturedAt,
        uri: focusedPicture.uri,
        width: focusedPicture.width,
        height: focusedPicture.height,
        sizeBytes: estimateBase64DecodedBytes(focusedPicture.base64),
      };
      setLastFrame(sample);
      setFrameCount((current) => current + 1);
      const transcript = speechText.trim();
      if (textOnlyDelivery && (!transcript || transcript === lastDeliveredSpeechRef.current)) {
        return;
      }
      await deliverSample({
        frame: textOnlyDelivery ? undefined : sample,
        transcript,
        capturedAt,
      });
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  }, [
    cameraPermission?.granted,
    capturing,
    deliverSample,
    settings.captureMode,
    speechText,
    textOnlyDelivery,
  ]);

  const handlePreviewLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    setPreviewLayout({ height, width });
  }, []);

  const handleFocusGestureGrant = useCallback((event: GestureResponderEvent) => {
    const touches = event.nativeEvent.touches;
    gestureRef.current = {
      distance: touches.length >= 2 ? touchDistance(touches[0], touches[1]) : null,
      startTouches: touchPoint(touches),
      startViewport: viewportRef.current,
      touchCount: touches.length,
    };
  }, []);

  const handleFocusGestureMove = useCallback(
    (event: GestureResponderEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || previewLayout.width <= 0 || previewLayout.height <= 0) return;
      const touches = event.nativeEvent.touches;
      if (touches.length >= 2) {
        const distance = touchDistance(touches[0], touches[1]);
        if (gesture.touchCount < 2 || !gesture.distance || gesture.distance <= 0) {
          gestureRef.current = {
            distance,
            startTouches: touchPoint(touches),
            startViewport: viewportRef.current,
            touchCount: touches.length,
          };
          return;
        }
        const nextZoom = gesture.startViewport.zoom * (distance / gesture.distance);
        setLiveViewport({ ...gesture.startViewport, zoom: nextZoom });
        return;
      }
      if (touches.length === 1) {
        const point = touchPoint(touches);
        if (gesture.touchCount !== 1) {
          gestureRef.current = {
            distance: null,
            startTouches: point,
            startViewport: viewportRef.current,
            touchCount: 1,
          };
          return;
        }
        const dx = point.x - gesture.startTouches.x;
        const dy = point.y - gesture.startTouches.y;
        const zoom = gesture.startViewport.zoom;
        setLiveViewport({
          centerX: gesture.startViewport.centerX - dx / (previewLayout.width * zoom),
          centerY: gesture.startViewport.centerY - dy / (previewLayout.height * zoom),
          zoom,
        });
      }
    },
    [previewLayout.height, previewLayout.width, setLiveViewport],
  );

  const handleFocusGestureRelease = useCallback(() => {
    gestureRef.current = null;
    persistViewport();
  }, [persistViewport]);

  const deliverSpeechSample = useCallback(async () => {
    const transcript = speechText.trim();
    if (!transcript || transcript === lastDeliveredSpeechRef.current) return;
    await deliverSample({
      transcript,
      capturedAt: new Date().toISOString(),
    });
  }, [deliverSample, speechText]);

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
    if (!running || capturesCamera(settings.captureMode) || !capturesAudio(settings.captureMode))
      return;
    const id = setInterval(() => {
      void deliverSpeechSample();
    }, settings.intervalSeconds * 1000);
    return () => clearInterval(id);
  }, [deliverSpeechSample, running, settings.captureMode, settings.intervalSeconds]);

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

  const cameraPreviewKey = `${settings.captureMode}:${facing}:${cameraPermission?.granted ? "granted" : "pending"}`;
  const cameraPreviewReady =
    cameraPreviewState.key === cameraPreviewKey && cameraPreviewState.ready;
  const cameraMountError =
    cameraPreviewState.key === cameraPreviewKey ? cameraPreviewState.error : null;
  const cameraStartReady = !capturesCamera(settings.captureMode) || cameraPermission?.granted;
  const status = running
    ? capturing
      ? "Capturing"
      : delivering
        ? "Delivering"
        : recognizing
          ? "Listening"
          : "Running"
    : "Stopped";

  return (
    <Card className="overflow-hidden rounded-lg">
      <View className="border-b border-border px-5 py-4 md:flex-row md:items-center md:justify-between">
        <View className="min-w-0">
          <Text className="text-base font-semibold text-foreground">Live monitor</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            {deliveryEnabled && deliveryLabel
              ? `${status} - delivering to ${deliveryLabel}`
              : status}
          </Text>
          {deliveryHint ? (
            <Text className="mt-1 text-xs text-muted-foreground">{deliveryHint}</Text>
          ) : null}
          {deliveryError ? (
            <Text className="mt-1 text-xs text-red-400">{deliveryError}</Text>
          ) : null}
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
            disabled={!running && startDisabled}
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
              {running ? "Stop" : cameraStartReady ? "Start" : "Allow camera"}
            </Text>
          </Button>
        </View>
      </View>

      <View className="gap-4 p-5 md:flex-row">
        <View className="min-w-0 flex-1">
          {capturesCamera(settings.captureMode) ? (
            <View
              className="overflow-hidden rounded-lg border border-border bg-background"
              collapsable={false}
              onLayout={handlePreviewLayout}
              style={styles.cameraPreviewFrame}
            >
              {cameraPermission?.granted ? (
                <>
                  <CameraView
                    key={cameraPreviewKey}
                    ref={cameraRef}
                    active
                    facing={facing}
                    mode="picture"
                    onCameraReady={() => {
                      setCameraPreviewState({ error: null, key: cameraPreviewKey, ready: true });
                    }}
                    onMountError={(event) => {
                      setCameraPreviewState({
                        error: event.message,
                        key: cameraPreviewKey,
                        ready: false,
                      });
                    }}
                    style={[
                      StyleSheet.absoluteFill,
                      cameraPreviewTransform(viewport, previewLayout),
                    ]}
                  />
                  <View
                    className="absolute inset-0"
                    onMoveShouldSetResponder={() => true}
                    onResponderGrant={handleFocusGestureGrant}
                    onResponderMove={handleFocusGestureMove}
                    onResponderRelease={handleFocusGestureRelease}
                    onResponderTerminate={handleFocusGestureRelease}
                    onStartShouldSetResponder={() => true}
                  >
                    <View className="absolute inset-0 border border-white/20" />
                    <View className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70 bg-black/25" />
                    <View className="absolute bottom-3 left-3 rounded-md bg-black/60 px-2 py-1">
                      <Text className="text-[11px] font-semibold text-white">
                        {viewport.zoom.toFixed(1)}x
                      </Text>
                    </View>
                  </View>
                  {!cameraPreviewReady || cameraMountError ? (
                    <View className="absolute inset-0 items-center justify-center bg-background/80 px-5">
                      <CameraIcon size={28} color="#71717a" />
                      <Text className="mt-3 text-center text-sm text-muted-foreground">
                        {cameraMountError ?? "Starting camera preview..."}
                      </Text>
                    </View>
                  ) : null}
                </>
              ) : lastFrame ? (
                <Image
                  source={{ uri: lastFrame.uri }}
                  resizeMode="cover"
                  style={StyleSheet.absoluteFill}
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
              <Text className="text-xs text-muted-foreground">{deliveryCount} delivered</Text>
            </View>
            <View className="rounded-lg border border-border px-3 py-2">
              <Text className="text-xs text-muted-foreground">
                {lastFrame ? `${Math.round(lastFrame.sizeBytes / 1024)} KB` : "Pinch + drag"}
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

const styles = StyleSheet.create({
  cameraPreviewFrame: {
    aspectRatio: 4 / 3,
    minHeight: 220,
  },
});

function normalizeViewport(viewport: MonitorCameraViewport): MonitorCameraViewport {
  const zoom = clamp(viewport.zoom, MONITOR_CAMERA_MIN_ZOOM, MONITOR_CAMERA_MAX_ZOOM);
  const minCenter = 1 / (2 * zoom);
  const maxCenter = 1 - minCenter;
  return {
    centerX: clamp(viewport.centerX, minCenter, maxCenter),
    centerY: clamp(viewport.centerY, minCenter, maxCenter),
    zoom,
  };
}

function cameraPreviewTransform(viewport: MonitorCameraViewport, layout: PreviewLayout) {
  if (layout.width <= 0 || layout.height <= 0) return null;
  const normalized = normalizeViewport(viewport);
  return {
    transform: [
      { translateX: (0.5 - normalized.centerX) * layout.width * normalized.zoom },
      { translateY: (0.5 - normalized.centerY) * layout.height * normalized.zoom },
      { scale: normalized.zoom },
    ],
  };
}

async function cropPictureToViewport(
  picture: CameraCapturedPicture,
  viewport: MonitorCameraViewport,
): Promise<Required<Pick<CameraCapturedPicture, "base64" | "height" | "uri" | "width">>> {
  if (!picture.base64) throw new Error("Camera frame did not include image data.");
  const normalized = normalizeViewport(viewport);
  if (normalized.zoom <= 1.01) {
    return {
      base64: picture.base64,
      height: picture.height,
      uri: picture.uri,
      width: picture.width,
    };
  }
  const cropWidth = Math.max(1, Math.round(picture.width / normalized.zoom));
  const cropHeight = Math.max(1, Math.round(picture.height / normalized.zoom));
  const originX = clamp(
    Math.round(normalized.centerX * picture.width - cropWidth / 2),
    0,
    picture.width - cropWidth,
  );
  const originY = clamp(
    Math.round(normalized.centerY * picture.height - cropHeight / 2),
    0,
    picture.height - cropHeight,
  );
  const focused = await manipulateAsync(
    picture.uri,
    [
      {
        crop: {
          height: cropHeight,
          originX,
          originY,
          width: cropWidth,
        },
      },
    ],
    {
      base64: true,
      compress: MONITOR_IMAGE_QUALITY,
      format: SaveFormat.JPEG,
    },
  );
  if (!focused.base64) throw new Error("Focused camera frame did not include image data.");
  return {
    base64: focused.base64,
    height: focused.height,
    uri: focused.uri,
    width: focused.width,
  };
}

function touchPoint(touches: GestureResponderEvent["nativeEvent"]["touches"]) {
  if (touches.length === 0) return { x: 0, y: 0 };
  const total = touches.reduce(
    (acc, touch) => ({ x: acc.x + touch.locationX, y: acc.y + touch.locationY }),
    { x: 0, y: 0 },
  );
  return {
    x: total.x / touches.length,
    y: total.y / touches.length,
  };
}

function touchDistance(
  first: GestureResponderEvent["nativeEvent"]["touches"][number],
  second: GestureResponderEvent["nativeEvent"]["touches"][number],
) {
  return Math.hypot(first.locationX - second.locationX, first.locationY - second.locationY);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
