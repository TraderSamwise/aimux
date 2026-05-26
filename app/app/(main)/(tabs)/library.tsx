import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useAtomValue } from "jotai";
import { BookOpen, FileText, RefreshCw } from "lucide-react-native";
import { DetailPanel } from "@/components/DetailPanel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { listProjectLibrary, type LibraryDocument } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { selectedProjectAtom, selectedProjectEndpointAtom } from "@/stores/projects";

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
  const project = useAtomValue(selectedProjectAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const { getToken } = useAuth();
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedId) ?? documents[0] ?? null,
    [documents, selectedId],
  );

  const refresh = useCallback(async () => {
    if (!endpoint) {
      setDocuments([]);
      setSelectedId(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const token = await getToken();
      const response = await listProjectLibrary(endpoint, { token });
      setDocuments(response.documents);
      setSelectedId((current) =>
        current && response.documents.some((document) => document.id === current)
          ? current
          : (response.documents[0]?.id ?? null),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [endpoint, getToken]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="px-4 py-5 md:px-8">
      <View className="w-full max-w-[1100px]">
        <View className="mb-5 flex-row items-start justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Library
            </Text>
            <Text className="mt-1 text-[28px] font-bold leading-tight text-foreground">
              Project Specs
            </Text>
            <Text className="mt-1 text-sm text-muted-foreground" numberOfLines={1}>
              {project?.name ?? "No project selected"}
              {project?.path ? ` · ${project.path}` : ""}
            </Text>
          </View>
          <Button
            variant="outline"
            size="icon"
            disabled={!endpoint || loading}
            onPress={() => void refresh()}
            accessibilityLabel="Refresh library"
          >
            <RefreshCw size={18} color="#fafafa" />
          </Button>
        </View>

        {!project ? (
          <Card className="rounded-lg p-5">
            <Text className="text-base font-semibold text-foreground">No project selected</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              Pick a project from the sidebar.
            </Text>
          </Card>
        ) : !endpoint ? (
          <Card className="rounded-lg p-5">
            <Text className="text-base font-semibold text-foreground">Project host offline</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              Start the project host to load library documents.
            </Text>
          </Card>
        ) : error ? (
          <Card className="rounded-lg border-destructive/50 bg-destructive/10 p-5">
            <Text className="text-base font-semibold text-foreground">Library failed</Text>
            <Text className="mt-1 text-sm text-muted-foreground">{error}</Text>
          </Card>
        ) : documents.length === 0 ? (
          <Card className="rounded-lg p-5">
            <Text className="text-base font-semibold text-foreground">No library documents</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              Durable project instruction files will appear here when present.
            </Text>
          </Card>
        ) : (
          <View className="gap-4 lg:flex-row">
            <Card className="overflow-hidden rounded-xl p-0 lg:w-[320px]">
              {documents.map((document) => (
                <DocumentRow
                  key={document.id}
                  document={document}
                  selected={document.id === selectedDocument?.id}
                  onPress={() => setSelectedId(document.id)}
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
      </View>
    </ScrollView>
  );
}
