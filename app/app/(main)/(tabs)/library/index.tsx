import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, View } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { BookOpen, FileText, RefreshCw } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { DetailPanel } from "@/components/DetailPanel";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { listProjectLibrary, type LibraryDocument } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useSerializedProjectApiRefresh } from "@/lib/project-api-refresh";
import { useRouteProject } from "@/lib/use-route-project";
import { cn } from "@/lib/utils";
import { buildViewHref, cleanSearchValue } from "@/lib/view-location";
import {
  applyLibraryFailureAtom,
  applyLibrarySuccessAtom,
  beginLibraryRefreshAtom,
  clearLibraryResourceAtom,
  isCurrentLibraryRequest,
  libraryResourceFamily,
  type LibraryRequestScope,
} from "@/stores/library";
import { projectApiViewRefreshNonceFamily } from "@/stores/projectViews";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  return `${Math.round(size / 1024)} KB`;
}

function DocumentRow({
  document,
  selected,
  onPress,
}: {
  document: LibraryDocument;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "border-b border-border px-4 py-3 active:bg-accent",
        selected && "bg-secondary",
      )}
    >
      <View className="flex-row items-center">
        <FileText size={15} color="#a1a1aa" />
        <Text className="ml-2 flex-1 text-[14px] font-semibold text-foreground">
          {document.title}
        </Text>
      </View>
      <Text className="mt-1 text-[11px] uppercase tracking-widest text-muted-foreground">
        {document.kind} · {formatBytes(document.size)}
        {document.truncated ? " · truncated" : ""}
      </Text>
    </Pressable>
  );
}

export default function LibraryScreen() {
  const { colorScheme } = useColorScheme();
  const foregroundIconColor = colorScheme === "dark" ? "#fafafa" : "#09090b";
  const { project, projectPath, endpoint, projectLoading } = useRouteProject();
  const projectPathKey = projectPath ?? "__aimux_no_selected_project__";
  const libraryRefreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("library"));
  const resource = useAtomValue(libraryResourceFamily(projectPathKey));
  const beginLibraryRefresh = useSetAtom(beginLibraryRefreshAtom);
  const applyLibrarySuccess = useSetAtom(applyLibrarySuccessAtom);
  const applyLibraryFailure = useSetAtom(applyLibraryFailureAtom);
  const clearLibraryResource = useSetAtom(clearLibraryResourceAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const searchParams = useGlobalSearchParams<{ document?: string | string[] }>();
  const selectedDocumentId = cleanSearchValue(searchParams.document);
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const endpointRef = useRef(endpoint);
  const endpointKeyRef = useRef(endpointKey);
  const projectPathRef = useRef(projectPathKey);
  const getTokenRef = useRef(getToken);
  const refreshSeqRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const requestScopeRef = useRef<LibraryRequestScope>({
    projectPath: projectPathKey,
    endpointKey,
    generation: 0,
  });

  useEffect(() => {
    endpointRef.current = endpoint;
    getTokenRef.current = getToken;
  }, [endpoint, getToken]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    endpointKeyRef.current = endpointKey;
    projectPathRef.current = projectPathKey;
    requestScopeRef.current = {
      projectPath: projectPathKey,
      endpointKey,
      generation: refreshGenerationRef.current,
    };
  }, [endpointKey, projectPathKey]);

  const visibleDocuments = useMemo(() => resource.value?.documents ?? [], [resource.value]);

  const selectedDocument = useMemo(
    () =>
      visibleDocuments.find((document) => document.id === selectedDocumentId) ??
      visibleDocuments[0] ??
      null,
    [selectedDocumentId, visibleDocuments],
  );

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentProjectPath = projectPathRef.current;
    const requestScope = {
      projectPath: currentProjectPath,
      endpointKey: endpointKeyRef.current,
      generation: refreshGenerationRef.current,
    };
    if (!currentEndpoint) {
      clearLibraryResource(currentProjectPath);
      return;
    }
    beginLibraryRefresh(currentProjectPath);
    try {
      const token = await getTokenRef.current();
      const response = await listProjectLibrary(currentEndpoint, { token });
      if (seq !== refreshSeqRef.current) return;
      if (!isCurrentLibraryRequest(requestScope, requestScopeRef.current)) return;
      applyLibrarySuccess({
        projectPath: currentProjectPath,
        library: {
          documents: response.documents,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      if (!isCurrentLibraryRequest(requestScope, requestScopeRef.current)) return;
      applyLibraryFailure({
        projectPath: currentProjectPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [applyLibraryFailure, applyLibrarySuccess, beginLibraryRefresh, clearLibraryResource]);
  const serializedRefresh = useSerializedProjectApiRefresh(refresh);

  useEffect(() => {
    const timer = setTimeout(() => {
      void serializedRefresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointKey, libraryRefreshNonce, projectPathKey, serializedRefresh]);

  const visibleError = resource.error;

  return (
    <Page>
      <PageHeader
        eyebrow="Library"
        title="Project Specs"
        subtitle={
          project
            ? `${project.name}${project.path ? ` · ${project.path}` : ""}`
            : projectLoading
              ? `Loading ${projectPath}`
              : "No project selected"
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            disabled={!endpoint || resource.pending}
            onPress={() => void serializedRefresh()}
            accessibilityLabel="Refresh library"
          >
            <RefreshCw size={18} color={foregroundIconColor} />
          </Button>
        }
      />

      {projectLoading ? (
        <PageStateCard title="Loading project..." body="Fetching project state from the daemon." />
      ) : !project ? (
        <PageStateCard title="No project selected" body="Pick a project from the sidebar." />
      ) : !endpoint ? (
        <PageStateCard
          title="Project host offline"
          body="Start the project host to load library documents."
        />
      ) : visibleError && !resource.value && !resource.pending ? (
        <PageStateCard title="Library failed" body={visibleError} tone="danger" />
      ) : visibleDocuments.length === 0 ? (
        <PageStateCard
          title={resource.pending ? "Loading library..." : "No library documents"}
          body="Durable project instruction files will appear here when present."
        />
      ) : (
        <View className="gap-4 lg:flex-row">
          <Card className="overflow-hidden rounded-xl p-0 lg:w-[320px]">
            {visibleDocuments.map((document) => (
              <DocumentRow
                key={document.id}
                document={document}
                selected={document.id === selectedDocument?.id}
                onPress={() =>
                  router.replace(
                    buildViewHref("/library", { project: projectPath, document: document.id }),
                  )
                }
              />
            ))}
          </Card>
          <DetailPanel
            title={selectedDocument?.title ?? "Document"}
            meta={selectedDocument?.path}
            icon={<BookOpen size={17} color="#a1a1aa" />}
          >
            <View>
              <Text className="font-mono text-[12px] leading-5 text-foreground">
                {selectedDocument?.content}
              </Text>
            </View>
          </DetailPanel>
        </View>
      )}
    </Page>
  );
}
