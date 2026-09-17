import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_defaultDirectiveFormatter,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type DataMessagePartProps,
  type TextMessagePartProps,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { LexicalComposerInput, type DirectiveChipProps } from "@assistant-ui/react-lexical";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ArrowUp, Check, ChevronDown, Copy, FileText, GitFork, LoaderCircle, MessageSquareQuote, Paperclip, Square, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { SkillTriggerPopover } from "./SkillTriggerPopover.js";
import { AttachmentMentionPopover } from "./AttachmentMentionPopover.js";
import { AttachmentDirectiveCleanupPlugin } from "./AttachmentDirectiveCleanupPlugin.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, streamChat } from "../api";
import { resolveComposerRecalledAttachments } from "../attachment-references";
import { DEFAULT_PROVIDER, isProviderName, type AgentSession, type ConfirmationRequest, type ConversationAnnotation, type ImageAttachmentRef, type ModelCatalog, type ProviderName, type SessionSummary, type StreamEvent, type TurnEvent, type UiMessage } from "../types";
import { groupModels, labelForProvider, providerAcceptsImages } from "../models";
import { TimelinePart } from "./Timeline";

type Props = {
  projectId: string;
  sessionId: string | null;
  sessionExists: boolean;
  provider: ProviderName;
  onProviderChange: (provider: ProviderName) => void;
  onSessionId: (id: string) => void;
  onRunningChange: (running: boolean) => void;
  onNotice?: (kind: "success" | "error", text: string) => void;
  queuedPrompt?: { sessionId: string; text: string } | null;
  onQueuedPromptConsumed?: () => void;
  initialAnchorTurnIndex?: number;
};

type DraftAnnotation = ConversationAnnotation & { anchorRatio: number };
type SelectionCandidate = Omit<DraftAnnotation, "id" | "comment"> & { x: number; y: number };
type AttachmentLabelState = { image: number; file: number; byFileId: Map<string, string> };

export function ChatWorkspace(props: Props) {
  const queryClient = useQueryClient();
  const historyQuery = useQuery({
    queryKey: ["session", props.projectId, props.sessionId],
    queryFn: ({ signal }) => api.getSession(props.projectId, props.sessionId!, signal),
    enabled: Boolean(props.sessionId && props.sessionExists),
    refetchInterval: (query) => isSessionRunning(query.state.data as AgentSession | undefined) ? 1_200 : false,
  });
  // The Skill catalog changes only when files on disk change, so it is fetched
  // once per project and reused for every turn.
  const modelsQuery = useQuery({ queryKey: ["models"], queryFn: ({ signal }) => api.listModels(signal), staleTime: 60_000 });
  // Callbacks below read the catalog through a ref so their dependency lists stay unchanged.
  const modelCatalogRef = useRef<ModelCatalog | undefined>(undefined);
  modelCatalogRef.current = modelsQuery.data;
  const skillsQuery = useQuery({
    queryKey: ["skills", props.projectId],
    queryFn: ({ signal }) => api.listSkills(props.projectId, signal),
    staleTime: 5 * 60_000,
  });
  const projectAttachmentReferencesQuery = useQuery({
    queryKey: ["attachment-references", props.projectId],
    queryFn: ({ signal }) => api.listProjectAttachmentReferences(props.projectId, signal),
    staleTime: 15_000,
  });
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [draftAnnotations, setDraftAnnotations] = useState<DraftAnnotation[]>([]);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [annotationTrayOpen, setAnnotationTrayOpen] = useState(false);
  const [draftAttachments, setDraftAttachments] = useState<ImageAttachmentRef[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [forkingTurnIndex, setForkingTurnIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftAttachmentsRef = useRef<ImageAttachmentRef[]>([]);
  const nextAttachmentLabelRef = useRef<AttachmentLabelState>(createAttachmentLabelState());
  const abortRef = useRef<AbortController | null>(null);
  const activeTurnIndexRef = useRef(-1);
  const partialAnswerRef = useRef("");
  const currentSessionRef = useRef(props.sessionId);
  const runningRef = useRef(false);
  const queueRef = useRef<StreamEvent[]>([]);
  const frameRef = useRef<number | null>(null);
  const draftAnnotationsRef = useRef<DraftAnnotation[]>([]);
  const loadedAnnotationKeyRef = useRef("");
  const handledSourceAnchorRef = useRef("");
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { currentSessionRef.current = props.sessionId; }, [props.sessionId]);
  useEffect(() => { runningRef.current = isRunning; props.onRunningChange(isRunning); }, [isRunning, props.onRunningChange]);
  useEffect(() => { draftAnnotationsRef.current = draftAnnotations; }, [draftAnnotations]);
  useEffect(() => { draftAttachmentsRef.current = draftAttachments; }, [draftAttachments]);

  useEffect(() => {
    if (props.initialAnchorTurnIndex === undefined || !historyQuery.data) return;
    const targetId = `${historyQuery.data.id}-user-${props.initialAnchorTurnIndex}`;
    if (handledSourceAnchorRef.current === targetId || !messages.some((message) => message.id === targetId)) return;
    handledSourceAnchorRef.current = targetId;

    // A long transcript gains height in several passes while Markdown, images
    // and HTML previews mount. One early scroll lands at the right row and then
    // drifts thousands of pixels away as earlier turns expand, so gently correct
    // the anchor during that short settling window. Any direct user interaction
    // cancels the remaining corrections.
    let cancelled = false;
    const delays = [0, 100, 350, 900, 1_800, 3_500];
    const timers = delays.map((delay) => window.setTimeout(() => {
      if (cancelled) return;
      document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(targetId)}"]`)
        ?.scrollIntoView({ block: "center" });
    }, delay));
    const viewport = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(targetId)}"]`)
      ?.closest<HTMLElement>(".thread-viewport") || null;
    const cancelForUser = () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
    viewport?.addEventListener("wheel", cancelForUser, { once: true });
    viewport?.addEventListener("pointerdown", cancelForUser, { once: true });
    viewport?.addEventListener("touchstart", cancelForUser, { once: true });
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      viewport?.removeEventListener("wheel", cancelForUser);
      viewport?.removeEventListener("pointerdown", cancelForUser);
      viewport?.removeEventListener("touchstart", cancelForUser);
    };
  }, [historyQuery.data, messages, props.initialAnchorTurnIndex]);

  const annotationStorageKey = annotationDraftKey(props.projectId, props.sessionId);
  useEffect(() => {
    let restored: DraftAnnotation[] = [];
    try {
      const raw = sessionStorage.getItem(annotationStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) restored = parsed.filter(isDraftAnnotation);
    } catch {}
    loadedAnnotationKeyRef.current = annotationStorageKey;
    draftAnnotationsRef.current = restored;
    setDraftAnnotations(restored);
    setEditingAnnotationId(null);
    setAnnotationTrayOpen(false);
    setDraftAttachments([]);
    nextAttachmentLabelRef.current = createAttachmentLabelState();
    setAttachmentError("");
  }, [annotationStorageKey]);

  useEffect(() => {
    if (loadedAnnotationKeyRef.current !== annotationStorageKey) return;
    if (draftAnnotations.length) sessionStorage.setItem(annotationStorageKey, JSON.stringify(draftAnnotations));
    else sessionStorage.removeItem(annotationStorageKey);
  }, [annotationStorageKey, draftAnnotations]);

  useEffect(() => {
    // A local SSE stream owns the live state. Otherwise the persisted Session
    // is authoritative, including a task that kept running across a reload.
    if (abortRef.current) return;
    if (historyQuery.data) {
      const restored = sessionToUiMessages(historyQuery.data);
      nextAttachmentLabelRef.current = createAttachmentLabelState([
        ...collectSessionAttachments(historyQuery.data),
        ...draftAttachmentsRef.current,
      ]);
      const remoteRunning = isSessionRunning(historyQuery.data);
      setMessages(restored);
      setIsRunning(remoteRunning);
      runningRef.current = remoteRunning;
      if (remoteRunning) {
        activeTurnIndexRef.current = Math.max(0, historyQuery.data.turns.length - 1);
        partialAnswerRef.current = [...restored].reverse().find((message) => message.role === "assistant")?.text || "";
      }
    } else if (!props.sessionExists) {
      setMessages([]);
      nextAttachmentLabelRef.current = createAttachmentLabelState(draftAttachmentsRef.current);
      setIsRunning(false);
      runningRef.current = false;
    }
  }, [historyQuery.data, props.sessionExists]);

  const stop = useCallback(async () => {
    const controller = abortRef.current;
    const sessionId = currentSessionRef.current;
    if (sessionId && runningRef.current) {
      void api.stopGeneration(props.projectId, sessionId, activeTurnIndexRef.current, partialAnswerRef.current).catch(() => undefined);
    }
    controller?.abort();
    setMessages((current) => updateLiveAssistant(current, (message) => ({ ...message, status: "stopped", text: message.text || partialAnswerRef.current })));
    setIsRunning(false);
  }, [props.projectId]);

  useEffect(() => () => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    // Unmounting or losing the page only detaches this client. The server-side
    // Session keeps running; only the explicit stop action calls stopGeneration.
    abortRef.current?.abort();
  }, []);

  const flushEvents = useCallback(() => {
    frameRef.current = null;
    const batch = queueRef.current.splice(0);
    if (!batch.length) return;
    for (const event of batch) {
      if (event.type === "session" && typeof event.data.id === "string") {
        currentSessionRef.current = event.data.id;
        props.onSessionId(event.data.id);
        if (isProviderName(event.data.modelProvider)) {
          props.onProviderChange(event.data.modelProvider);
        }
      }
      if (event.type === "turn_info" && typeof event.data.turnIndex === "number") activeTurnIndexRef.current = event.data.turnIndex;
      if (event.type === "confirmation") setConfirmation(event.data as ConfirmationRequest);
    }
    setMessages((current) => applyStreamBatch(current, batch, partialAnswerRef));
  }, [props.onProviderChange, props.onSessionId]);

  const enqueueEvent = useCallback((event: StreamEvent) => {
    queueRef.current.push(event);
    if (frameRef.current == null) frameRef.current = requestAnimationFrame(flushEvents);
  }, [flushEvents]);

  const sendText = useCallback(async (text: string, resumeTurnIndex?: number) => {
    const message = text.trim();
    const outgoingAttachments = resumeTurnIndex === undefined
      ? selectOutgoingAttachments(message, draftAttachmentsRef.current)
      : [];
    const annotations = resumeTurnIndex === undefined
      ? draftAnnotationsRef.current.map(({ anchorRatio: _anchorRatio, ...annotation }) => annotation)
      : [];
    if ((!message && !annotations.length && !outgoingAttachments.length) || runningRef.current) return;
    if (!providerAcceptsImages(modelCatalogRef.current, props.provider) && outgoingAttachments.length) {
      setAttachmentError("当前模型不能读取附件，请新建会话并选择支持图片的模型后再发送。");
      return;
    }
    const now = new Date().toISOString();
    if (resumeTurnIndex === undefined) {
      const optimisticAttachments = outgoingAttachments.map((attachment) => ({
        ...attachment,
        previewUrl: attachment.fileId
          ? projectFileContentUrl(props.projectId, attachment.fileId)
          : attachment.previewUrl || attachment.dataUrl,
      }));
      outgoingAttachments.forEach((attachment) => {
        if (attachment.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUrl);
      });
      const user: UiMessage = { id: crypto.randomUUID(), role: "user", text: message, annotations, attachments: optimisticAttachments, createdAt: now };
      const assistant: UiMessage = { id: crypto.randomUUID(), role: "assistant", text: "", modelProvider: props.provider, createdAt: now, events: [], status: "running" };
      setMessages((current) => [...current, user, assistant]);
      setDraftAnnotations([]);
      draftAnnotationsRef.current = [];
      setAnnotationTrayOpen(false);
      setEditingAnnotationId(null);
      setComposerText("");
      setDraftAttachments([]);
      draftAttachmentsRef.current = [];
      setAttachmentError("");
      sessionStorage.removeItem(annotationStorageKey);
      sessionStorage.removeItem(draftKey(props.projectId, props.sessionId));
      partialAnswerRef.current = "";
      activeTurnIndexRef.current = -1;
    } else {
      activeTurnIndexRef.current = resumeTurnIndex;
      setMessages((current) => updateLiveAssistant(current, (item) => ({ ...item, status: "running" })));
    }
    setConfirmation(null);
    setIsRunning(true);
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat({
        projectId: props.projectId,
        sessionId: currentSessionRef.current || undefined,
        message,
        annotations,
        attachments: outgoingAttachments.map(({ previewUrl: _previewUrl, dataUrl: _dataUrl, ...attachment }) => attachment),
        provider: props.provider,
        resumeTurnIndex,
      }, enqueueEvent, controller.signal);
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        flushEvents();
      }
      setMessages((current) => updateLiveAssistant(current, (item) => item.status === "running" ? { ...item, status: "completed" } : item));
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setMessages((current) => updateLiveAssistant(current, (item) => ({ ...item, status: "error", text: item.text || `请求失败：${(error as Error).message}` })));
      }
    } finally {
      abortRef.current = null;
      setIsRunning(false);
      runningRef.current = false;
      void queryClient.invalidateQueries({ queryKey: ["sessions", props.projectId] });
      void queryClient.invalidateQueries({ queryKey: ["attachment-references", props.projectId] });
    }
  }, [annotationStorageKey, enqueueEvent, flushEvents, props.projectId, props.provider, props.sessionId, queryClient]);

  const stoppedTurnIndex = useMemo(() => {
    const assistants = messages.filter((message) => message.role === "assistant");
    return assistants.length && assistants[assistants.length - 1]?.status === "stopped" ? assistants.length - 1 : -1;
  }, [messages]);

  const resumeStoppedTurn = useCallback(() => {
    if (stoppedTurnIndex < 0 || isRunning) return;
    const turn = historyQuery.data?.turns[stoppedTurnIndex];
    if (turn) void sendText(turn.userContent, stoppedTurnIndex);
  }, [historyQuery.data?.turns, isRunning, sendText, stoppedTurnIndex]);

  const addSelectionToConversation = useCallback((selectionCandidate: SelectionCandidate) => {
    const id = crypto.randomUUID();
    const { x: _x, y: _y, ...candidate } = selectionCandidate;
    setDraftAnnotations((current) => {
      const next = [...current, { id, comment: "", ...candidate }];
      draftAnnotationsRef.current = next;
      return next;
    });
    setEditingAnnotationId(id);
    window.getSelection()?.removeAllRanges();
  }, []);

  const updateAnnotationDraft = useCallback((id: string, comment: string) => {
    draftAnnotationsRef.current = draftAnnotationsRef.current
      .map((annotation) => annotation.id === id ? { ...annotation, comment } : annotation);
  }, []);

  const commitAnnotation = useCallback((id: string, comment: string) => {
    const next = draftAnnotationsRef.current
      .map((annotation) => annotation.id === id ? { ...annotation, comment } : annotation);
    draftAnnotationsRef.current = next;
    setDraftAnnotations(next);
  }, []);

  const removeAnnotation = useCallback((id: string) => {
    const next = draftAnnotationsRef.current.filter((annotation) => annotation.id !== id);
    draftAnnotationsRef.current = next;
    setDraftAnnotations(next);
    setEditingAnnotationId((current) => current === id ? null : current);
  }, []);

  const jumpToAnnotation = useCallback((annotation: DraftAnnotation) => {
    const target = document.querySelector<HTMLElement>(`.assistant-message[data-turn-index="${annotation.sourceTurnIndex}"] [data-annotation-source="${annotation.sourceKind}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const addAttachmentFiles = useCallback(async (files: FileList | File[]) => {
    const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown"]);
    const candidates = Array.from(files);
    if (!candidates.length) return;
    if (!providerAcceptsImages(modelCatalogRef.current, props.provider)) {
      setAttachmentError("当前模型不能读取附件，请先新建会话并选择支持图片的模型。");
      return;
    }
    if (draftAttachmentsRef.current.length + candidates.length > 60) {
      setAttachmentError("每条消息最多发送 60 个附件。");
      return;
    }
    for (const file of candidates) {
      const normalizedType = normalizeBrowserMime(file);
      if (!allowed.has(normalizedType)) {
        setAttachmentError("支持 PNG、JPEG、GIF、WebP、PDF、TXT 和 Markdown 文件。");
        return;
      }
      if (file.size > 64 * 1024 * 1024) {
        setAttachmentError("单个附件不能超过 64 MB。");
        return;
      }
    }
    const total = [...draftAttachmentsRef.current.map((item) => item.size), ...candidates.map((file) => file.size)]
      .reduce((sum, size) => sum + size, 0);
    if (total > 200 * 1024 * 1024) {
      setAttachmentError("一条消息中的附件合计不能超过 200 MB。");
      return;
    }
    // The API rejects any side over 8192 px, so tall screenshots are caught
    // here rather than surfacing as a generic 400 after the turn is sent.
    const images = candidates.filter((file) => normalizeBrowserMime(file).startsWith("image/"));
    const maxSide = images.length >= 15 ? 4096 : 8192;
    for (const file of images) {
      const size = await readImageSize(file);
      if (size && (size.width > maxSide || size.height > maxSide)) {
        setAttachmentError(
          `${file.name || "图片"} 尺寸为 ${size.width}×${size.height}，超出上限（单边最多 ${maxSide} px）。长截图请分段裁切后再发送。`,
        );
        return;
      }
    }
    try {
      const added: ImageAttachmentRef[] = [];
      for (const file of candidates) {
        const attachment = await api.uploadAttachment(props.projectId, file);
        added.push({
          ...attachment,
          // Labels are Session handles, not fields on the Project's
          // content-addressed file record. The Session label state below
          // decides whether this file reuses an existing handle.
          label: "",
          previewUrl: attachment.kind === "image" || attachment.mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      setDraftAttachments((current) => {
        const seenFileIds = new Set(current.flatMap((item) => item.fileId ? [item.fileId] : []));
        const uniqueAdded = added.filter((item) => {
          if (!item.fileId || !seenFileIds.has(item.fileId)) {
            if (item.fileId) seenFileIds.add(item.fileId);
            return true;
          }
          if (item.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
          return false;
        });
        return assignStableAttachmentLabels([...current, ...uniqueAdded], nextAttachmentLabelRef.current);
      });
      void queryClient.invalidateQueries({ queryKey: ["project-files", props.projectId] });
      setAttachmentError("");
    } catch (error) {
      setAttachmentError((error as Error).message || "附件上传失败。");
    }
  }, [props.projectId, props.provider, queryClient]);

  const removeDraftAttachment = useCallback((id: string) => {
    setDraftAttachments((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const modelLocked = Boolean(historyQuery.data?.modelProvider || messages.length);
  const activeProvider = historyQuery.data?.modelProvider || props.provider;
  const activeAcceptsImages = providerAcceptsImages(modelsQuery.data, activeProvider);
  const modelGroups = groupModels(modelsQuery.data, activeProvider);

  const runtime = useExternalStoreRuntime<UiMessage>({
    messages,
    isRunning,
    convertMessage: convertUiMessage,
    onNew: async (message) => sendText(extractText(message)),
    onCancel: stop,
  });

  useEffect(() => {
    const key = draftKey(props.projectId, props.sessionId);
    const text = sessionStorage.getItem(key) || "";
    setComposerText(text);
    runtime.thread.composer.setText(text);
  }, [props.projectId, props.sessionId, runtime]);

  const persistComposerText = useCallback((text: string) => {
    setComposerText(text);
    sessionStorage.setItem(draftKey(props.projectId, props.sessionId), text);
  }, [props.projectId, props.sessionId]);

  const sendableAttachmentCount = useMemo(
    () => selectOutgoingAttachments(composerText, draftAttachments).length,
    [composerText, draftAttachments],
  );

  const submitComposer = useCallback(() => {
    if ((!composerText.trim() && !draftAnnotationsRef.current.length && !sendableAttachmentCount) || runningRef.current) return;
    runtime.thread.composer.setText("");
    void sendText(composerText);
  }, [composerText, runtime, sendText, sendableAttachmentCount]);

  const validAttachmentIds = useMemo(() => new Set(draftAttachments.map((attachment) => attachment.id)), [draftAttachments]);
  const sessionReferenceAttachments = useMemo(
    () => historyQuery.data ? collectSessionReferenceAttachments(historyQuery.data) : [],
    [historyQuery.data],
  );
  const sessionFileIds = useMemo(() => new Set(
    (historyQuery.data ? collectSessionAttachments(historyQuery.data) : [])
      .flatMap((attachment) => attachment.fileId ? [attachment.fileId] : []),
  ), [historyQuery.data]);
  const projectReferenceAttachments = useMemo(() => (projectAttachmentReferencesQuery.data || [])
    .filter((attachment) => !attachment.fileId || !sessionFileIds.has(attachment.fileId))
    .map((attachment) => ({
      ...attachment,
      previewUrl: attachment.fileId ? projectFileContentUrl(props.projectId, attachment.fileId) : attachment.previewUrl,
    })), [projectAttachmentReferencesQuery.data, props.projectId, sessionFileIds]);

  const rememberRecalledAttachment = useCallback((attachment: ImageAttachmentRef) => {
    setDraftAttachments((current) => current.some((item) => item.id === attachment.id)
      ? current
      : [...current, {
          ...attachment,
          previewUrl: attachment.fileId ? projectFileContentUrl(props.projectId, attachment.fileId) : attachment.previewUrl,
        }]);
    setAttachmentError("");
  }, [props.projectId]);

  useEffect(() => {
    // Lexical owns directive insertion and intentionally intercepts the
    // TriggerPopover's `onInserted` callback. The serialized chip therefore
    // has to be the source of truth: resolve every recalled directive back to
    // its attachment before submission (also restores recalled draft chips
    // after a page reload).
    setDraftAttachments((current) => {
      const local = current.filter((attachment) => !attachment.referenceScope);
      const recalled = resolveComposerRecalledAttachments(
        composerText,
        [...sessionReferenceAttachments, ...projectReferenceAttachments],
      ).map((attachment) => ({
          ...attachment,
          previewUrl: attachment.fileId ? projectFileContentUrl(props.projectId, attachment.fileId) : attachment.previewUrl,
        }));
      if (local.length + recalled.length === current.length
        && [...local, ...recalled].every((attachment, index) => attachment.id === current[index]?.id)) return current;
      return [...local, ...recalled];
    });
  }, [composerText, projectReferenceAttachments, props.projectId, sessionReferenceAttachments]);

  useEffect(() => {
    if (!props.queuedPrompt || props.queuedPrompt.sessionId !== props.sessionId || isRunning) return;
    props.onQueuedPromptConsumed?.();
    void sendText(props.queuedPrompt.text);
  }, [isRunning, props.onQueuedPromptConsumed, props.queuedPrompt, props.sessionId, sendText]);

  async function resolveConfirmation(decision: "allow" | "deny") {
    if (!confirmation) return;
    setConfirmationBusy(true);
    try {
      const result = await api.resolveConfirmation(confirmation.id, decision);
      const content = result.result?.content || (decision === "deny" ? "已取消这项操作。" : "操作已完成。");
      setMessages((current) => [...current, {
        id: crypto.randomUUID(), role: "assistant", text: content, createdAt: new Date().toISOString(), status: "completed",
      }]);
      setConfirmation(null);
      void queryClient.invalidateQueries({ queryKey: ["session", props.projectId, props.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", props.projectId] });
    } finally { setConfirmationBusy(false); }
  }

  const assistantTurnById = useMemo(() => {
    const map = new Map<string, number>();
    let turnIndex = 0;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      map.set(message.id, turnIndex++);
    }
    return map;
  }, [messages]);
  const assistantModelById = useMemo(() => new Map(
    messages.filter((message) => message.role === "assistant").map((message) => [message.id, message.modelProvider]),
  ), [messages]);

  const forkFromTurn = useCallback(async (turnIndex: number) => {
    if (!props.sessionId || forkingTurnIndex !== null) return;
    setForkingTurnIndex(turnIndex);
    try {
      const branch = await api.forkSession(props.projectId, props.sessionId, turnIndex);
      queryClient.setQueryData<SessionSummary[]>(["sessions", props.projectId], (current = []) => [
        branch,
        ...current.filter((session) => session.id !== branch.id),
      ]);
      props.onProviderChange(branch.modelProvider || activeProvider);
      props.onSessionId(branch.id);
      props.onNotice?.("success", `已从第 ${turnIndex + 1} 轮创建分支`);
    } catch (error) {
      props.onNotice?.("error", (error as Error).message || "创建分支失败。");
    } finally {
      setForkingTurnIndex(null);
    }
  }, [activeProvider, forkingTurnIndex, props, queryClient]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="chat-workspace" ref={workspaceRef}>
        <ThreadPrimitive.Root className="thread-root">
          <ThreadPrimitive.Viewport className="thread-viewport" turnAnchor="bottom" autoScroll>
            <AuiIf condition={(state) => state.thread.isEmpty}>
              <div className="thread-empty"><div className="lazy-mark">L</div><h2>和 Lazy 一起想清楚</h2><p>从一个问题、一份文档，或一个尚未成形的想法开始。</p></div>
            </AuiIf>
            <ThreadPrimitive.Messages>
              {({ message }) => message.role === "user" ? <UserMessage projectId={props.projectId} /> : (
                <AssistantMessage
                  turnIndex={assistantTurnById.get(message.id) ?? 0}
                  modelLabel={labelForProvider(modelsQuery.data, assistantModelById.get(message.id) || activeProvider)}
                  running={message.status?.type === "running"}
                  annotations={draftAnnotations.filter((annotation) => annotation.sourceTurnIndex === (assistantTurnById.get(message.id) ?? 0))}
                  editingAnnotationId={editingAnnotationId}
                  onEditAnnotation={setEditingAnnotationId}
                  onDraftAnnotation={updateAnnotationDraft}
                  onCommitAnnotation={commitAnnotation}
                  onRemoveAnnotation={removeAnnotation}
                  onFork={() => void forkFromTurn(assistantTurnById.get(message.id) ?? 0)}
                  forking={forkingTurnIndex === (assistantTurnById.get(message.id) ?? 0)}
                />
              )}
            </ThreadPrimitive.Messages>
            <div className="thread-spacer" aria-hidden />
            <ThreadPrimitive.ViewportFooter className="composer-dock">
              {stoppedTurnIndex >= 0 && !isRunning && (
                <button className="resume-generation" type="button" onClick={resumeStoppedTurn}>继续生成</button>
              )}
              {confirmation && (
                <div className="confirmation-card">
                  <div><strong>需要你的确认</strong><span>{confirmation.message}</span><code>{confirmation.toolName} · {confirmation.inputPreview}</code></div>
                  <div className="confirmation-actions">
                    <button disabled={confirmationBusy} onClick={() => resolveConfirmation("deny")}><X size={15} />拒绝</button>
                    <button className="primary" disabled={confirmationBusy} onClick={() => resolveConfirmation("allow")}><Check size={15} />允许</button>
                  </div>
                </div>
              )}
              {draftAnnotations.length > 0 && (
                <div className="annotation-composer annotation-ui">
                  <button className="annotation-composer-toggle" type="button" onClick={() => setAnnotationTrayOpen((open) => !open)}>
                    <MessageSquareQuote size={14} />{draftAnnotations.length} 条批注
                  </button>
                  {annotationTrayOpen && <div className="annotation-composer-list">
                    {draftAnnotations.map((annotation) => (
                      <div className="annotation-composer-item" key={annotation.id}>
                        <button className="annotation-source-jump" type="button" onClick={() => jumpToAnnotation(annotation)}>
                          <span>正式回答</span>
                          <q>{annotation.selectedText}</q>
                        </button>
                        <AnnotationCommentInput
                          annotation={annotation}
                          onDraft={updateAnnotationDraft}
                          onCommit={commitAnnotation}
                          placeholder="写下你的批注"
                          rows={2}
                        />
                        <button className="annotation-delete" type="button" onClick={() => removeAnnotation(annotation.id)} aria-label="删除批注"><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>}
                </div>
              )}
              {draftAttachments.some((attachment) => !attachment.referenceScope) && <div className="image-draft-strip">
                {draftAttachments.filter((attachment) => !attachment.referenceScope).map((attachment) => <div className={`image-draft ${attachment.kind === "file" ? "is-file" : ""}`} key={attachment.id}>
                  {attachment.kind === "image" || attachment.mimeType.startsWith("image/")
                    ? <img src={attachment.previewUrl || attachment.dataUrl} alt={attachment.name} />
                    : <FileText size={24} />}
                  <span><strong>{attachment.label}</strong>{attachment.name}</span>
                  <button type="button" onClick={() => removeDraftAttachment(attachment.id)} aria-label={`移除 ${attachment.name}`}><X size={13} /></button>
                </div>)}
              </div>}
              {attachmentError && <div className="attachment-error">{attachmentError}</div>}
              <ComposerPrimitive.Unstable_TriggerPopoverRoot>
                <SkillTriggerPopover skills={skillsQuery.data || []} />
                <AttachmentMentionPopover attachments={draftAttachments.filter((attachment) => !attachment.referenceScope)} trigger="@" scope="current" currentSessionId={props.sessionId} />
                <AttachmentMentionPopover attachments={sessionReferenceAttachments} trigger="@@" scope="session" currentSessionId={props.sessionId} onInserted={rememberRecalledAttachment} />
                <AttachmentMentionPopover attachments={projectReferenceAttachments} trigger="@@@" scope="project" currentSessionId={props.sessionId} onInserted={rememberRecalledAttachment} />
                <ComposerPrimitive.Root
                  className="composer-root"
                  onDragOver={(event) => { if (activeAcceptsImages) event.preventDefault(); }}
                  onDrop={(event) => {
                    if (!event.dataTransfer.files.length) return;
                    event.preventDefault();
                    void addAttachmentFiles(event.dataTransfer.files);
                  }}
                >
                  {/* Lexical owns caret-aware inline directives; the runtime text
                      remains the durable source used for drafts and submission. */}
                  <ComposerTextSync onText={persistComposerText} />
                  <LexicalComposerInput
                    className="composer-input"
                    placeholder="输入消息，@ 本轮附件，@@ 本对话，@@@ 当前项目，/ 选择 Skill"
                    submitMode="ctrlEnter"
                    directiveChip={(chipProps) => <LazyDirectiveChip {...chipProps} projectId={props.projectId} />}
                    onPaste={(event) => {
                      const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                      if (images.length) {
                        event.preventDefault();
                        void addAttachmentFiles(images);
                      }
                    }}
                  >
                    <AttachmentDirectiveCleanupPlugin validAttachmentIds={validAttachmentIds} />
                  </LexicalComposerInput>
                  <div className="composer-toolbar">
                    <div className="composer-options">
                      <button
                        className="attach-image-button"
                        type="button"
                        disabled={!activeAcceptsImages}
                        title={activeAcceptsImages ? "添加附件" : "当前模型不支持附件"}
                        onClick={() => fileInputRef.current?.click()}
                      ><Paperclip size={15} />附件</button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,.md,.txt,.pdf"
                        multiple
                        hidden
                        onChange={(event) => {
                          if (event.target.files) void addAttachmentFiles(event.target.files);
                          event.target.value = "";
                        }}
                      />
                      <select value={activeProvider} disabled={modelLocked || isRunning} onChange={(event) => props.onProviderChange(event.target.value as ProviderName)} aria-label="模型" title={modelLocked ? "模型已由本会话第一条消息锁定" : "选择本会话模型"}>
                        {modelGroups.map((group) => (
                          <optgroup key={group.vendor} label={group.vendorLabel}>
                            {group.models.map((model) => (
                              <option key={model.id} value={model.id} disabled={!model.configured && model.id !== activeProvider}>
                                {model.label}{model.acceptsImages ? "" : "（不读图）"}{model.configured ? "" : "（未配置 Key）"}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      {modelLocked && <span className="model-lock-label">会话已锁定</span>}
                    </div>
                    <AuiIf condition={(state) => !state.thread.isRunning}>
                      <button className="send-button" type="button" aria-label="发送" disabled={!composerText.trim() && !draftAnnotations.length && !sendableAttachmentCount} onClick={submitComposer}><ArrowUp size={17} /></button>
                    </AuiIf>
                    <AuiIf condition={(state) => state.thread.isRunning}>
                      <ComposerPrimitive.Cancel className="stop-button" aria-label="停止生成"><Square size={13} fill="currentColor" /></ComposerPrimitive.Cancel>
                    </AuiIf>
                  </div>
                </ComposerPrimitive.Root>
              </ComposerPrimitive.Unstable_TriggerPopoverRoot>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
        <TextSelectionAction containerRef={workspaceRef} onAdd={addSelectionToConversation} />
      </div>
    </AssistantRuntimeProvider>
  );
}

/**
 * Keep transient browser-selection state below ChatWorkspace. Updating it at
 * the page root rerenders every Markdown message while the native selection is
 * still painted, which produces a visible one-frame flash on long answers.
 */
function TextSelectionAction({ containerRef, onAdd }: {
  containerRef: RefObject<HTMLDivElement | null>;
  onAdd: (candidate: SelectionCandidate) => void;
}) {
  const [candidate, setCandidate] = useState<SelectionCandidate | null>(null);
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseUp = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".annotation-ui")) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setCandidate(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const start = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer as Element
        : range.startContainer.parentElement;
      const end = range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer as Element
        : range.endContainer.parentElement;
      const source = start?.closest<HTMLElement>("[data-annotation-source]");
      const row = source?.closest<HTMLElement>(".assistant-message");
      const sourceTurnIndex = Number(row?.dataset.turnIndex);
      const selectedText = selection.toString().trim();
      if (!source
        || source !== end?.closest("[data-annotation-source]")
        || !row
        || row.dataset.running === "true"
        || !selectedText
        || !Number.isInteger(sourceTurnIndex)) {
        setCandidate(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const anchorRatio = rowRect.height > 0
        ? Math.max(0, Math.min(1, (rect.top - rowRect.top + rect.height / 2) / rowRect.height))
        : 0;
      setCandidate({
        sourceTurnIndex,
        sourceKind: "answer",
        selectedText,
        anchorRatio,
        x: Math.min(window.innerWidth - 152, Math.max(12, rect.right + 8)),
        y: Math.min(window.innerHeight - 44, Math.max(12, rect.bottom + 6)),
      });
    };
    const clear = () => setCandidate(null);
    container.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      container.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, [containerRef]);

  if (!candidate) return null;
  return (
    <button
      className="selection-add-to-chat annotation-ui"
      type="button"
      style={{ left: candidate.x, top: candidate.y }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onAddRef.current(candidate);
        setCandidate(null);
      }}
    ><MessageSquareQuote size={14} />添加到对话</button>
  );
}

/**
 * Mirrors the composer runtime's text into local React state.
 *
 * The Skill panel and any other runtime-side `setText` caller do not go through
 * the textarea's `onChange`, so without this bridge `composerText` would miss
 * those updates and the send button could stay disabled after picking a Skill.
 */
function ComposerTextSync({ onText }: { onText: (text: string) => void }) {
  const text = useAuiState((state) => state.composer.text);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  useEffect(() => { onTextRef.current(text); }, [text]);
  return null;
}

function UserMessage({ projectId }: { projectId: string }) {
  const messageId = useAuiState((state) => state.message.id);
  const copyText = useAuiState((state) => state.message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n"));
  return (
    <MessagePrimitive.Root className="message-row user-message" data-message-id={messageId}>
      <div className="message-role">你</div>
      <div className="message-card"><MessagePrimitive.Parts components={{ Text: (partProps) => <PlainTextPart {...partProps} projectId={projectId} />, data: { by_name: { "lazy-user-annotations": UserAnnotationsPart, "lazy-user-attachments": UserAttachmentsPart } } }} /></div>
      <MessageActions copyText={readableUserText(copyText)} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({ turnIndex, running, modelLabel, annotations, editingAnnotationId, onEditAnnotation, onDraftAnnotation, onCommitAnnotation, onRemoveAnnotation, onFork, forking }: {
  turnIndex: number;
  running: boolean;
  modelLabel: string;
  annotations: DraftAnnotation[];
  editingAnnotationId: string | null;
  onEditAnnotation: (id: string | null) => void;
  onDraftAnnotation: (id: string, comment: string) => void;
  onCommitAnnotation: (id: string, comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
  onFork: () => void;
  forking: boolean;
}) {
  return (
    <MessagePrimitive.Root className="message-row assistant-message" data-turn-index={turnIndex} data-running={running ? "true" : "false"}>
      <div className="message-role">Lazy · {modelLabel}</div>
      <div className="assistant-content">
        <MessagePrimitive.Parts components={{
          Text: MarkdownPart,
          data: { by_name: { "lazy-timeline": TimelinePart } },
        }} />
      </div>
      <MessageActions onFork={onFork} forkDisabled={running || forking} forking={forking} />
      <AnnotationMarkers
        annotations={annotations}
        editingAnnotationId={editingAnnotationId}
        onEdit={onEditAnnotation}
        onDraft={onDraftAnnotation}
        onCommit={onCommitAnnotation}
        onRemove={onRemoveAnnotation}
      />
    </MessagePrimitive.Root>
  );
}

function UserAttachmentsPart({ data }: DataMessagePartProps<{ attachments: ImageAttachmentRef[] }>) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  if (!data?.attachments?.length) return null;
  const visibleAttachments = data.attachments.filter((attachment: ImageAttachmentRef) => !attachment.referenceScope);
  if (!visibleAttachments.length) return null;
  const imageAttachments = visibleAttachments.filter((attachment: ImageAttachmentRef) => attachment.kind === "image" || attachment.mimeType.startsWith("image/"));
  const images = imageAttachments.map((attachment: ImageAttachmentRef) => ({
    id: attachment.id,
    name: attachment.name,
    url: attachment.previewUrl || attachment.dataUrl || "",
  }));
  return <>
    <div className="sent-images">
      {visibleAttachments.map((attachment: ImageAttachmentRef) => (
        <button
          type="button"
          className={attachment.kind === "file" ? "sent-file" : "sent-image"}
          key={attachment.id}
          onClick={() => {
            const index = imageAttachments.findIndex((item: ImageAttachmentRef) => item.id === attachment.id);
            if (index >= 0) setOpenAt(index);
            else if (attachment.previewUrl) window.open(attachment.previewUrl, "_blank", "noopener,noreferrer");
          }}
          aria-label={`${attachment.kind === "file" ? "打开" : "放大查看"} ${attachment.name}`}
        >
          {attachment.kind === "image" || attachment.mimeType.startsWith("image/")
            ? <><img src={attachment.previewUrl || attachment.dataUrl} alt={attachment.name} /><span className="sent-image-copy"><strong>{attachment.label}</strong>{attachment.name}</span></>
            : <><span className="sent-file-icon"><FileText size={22} /></span><span className="sent-file-copy"><strong>{attachment.label}</strong><small>{attachment.name}</small></span></>}
        </button>
      ))}
    </div>
    {openAt !== null && (
      <ImageLightbox images={images} index={openAt} onIndexChange={setOpenAt} onClose={() => setOpenAt(null)} />
    )}
  </>;
}

function UserAnnotationsPart({ data }: DataMessagePartProps<{ annotations: ConversationAnnotation[] }>) {
  if (!data?.annotations?.length) return null;
  return <div className="sent-annotations">
    {data.annotations.map((annotation: ConversationAnnotation) => <div className="sent-annotation" key={annotation.id}>
      <span>正式回答</span>
      <q>{annotation.selectedText}</q>
      {annotation.comment && <p>{annotation.comment}</p>}
    </div>)}
  </div>;
}

function AnnotationCommentInput({ annotation, onDraft, onCommit, placeholder, rows, autoFocus = false }: {
  annotation: DraftAnnotation;
  onDraft: (id: string, comment: string) => void;
  onCommit: (id: string, comment: string) => void;
  placeholder: string;
  rows: number;
  autoFocus?: boolean;
}) {
  const [comment, setComment] = useState(annotation.comment);
  const onDraftRef = useRef(onDraft);
  const onCommitRef = useRef(onCommit);
  onDraftRef.current = onDraft;
  onCommitRef.current = onCommit;

  useEffect(() => { setComment(annotation.comment); }, [annotation.id, annotation.comment]);

  return (
    <textarea
      autoFocus={autoFocus}
      value={comment}
      onChange={(event) => {
        const next = event.target.value;
        setComment(next);
        onDraftRef.current(annotation.id, next);
      }}
      onBlur={() => onCommitRef.current(annotation.id, comment)}
      placeholder={placeholder}
      rows={rows}
    />
  );
}

function AnnotationMarkers({ annotations, editingAnnotationId, onEdit, onDraft, onCommit, onRemove }: {
  annotations: DraftAnnotation[];
  editingAnnotationId: string | null;
  onEdit: (id: string | null) => void;
  onDraft: (id: string, comment: string) => void;
  onCommit: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!annotations.length) return null;
  return <div className="annotation-markers annotation-ui">
    {annotations.map((annotation, index) => {
      const editing = annotation.id === editingAnnotationId;
      return <div className="annotation-marker-wrap" style={{ top: `${annotation.anchorRatio * 100}%`, zIndex: editing ? 4 : 2 }} key={annotation.id}>
        <button className="annotation-marker" type="button" onClick={() => onEdit(editing ? null : annotation.id)} aria-label={`批注 ${index + 1}`}>
          {index + 1}
        </button>
        {editing && <div className="annotation-editor">
          <div className="annotation-editor-quote"><q>{annotation.selectedText}</q></div>
          <AnnotationCommentInput
            annotation={annotation}
            onDraft={onDraft}
            onCommit={onCommit}
            placeholder="写下你的批注"
            rows={3}
            autoFocus
          />
          <div className="annotation-editor-actions">
            <button type="button" onClick={() => onRemove(annotation.id)}><Trash2 size={13} />删除</button>
            <button className="primary" type="button" onClick={() => onEdit(null)}><Check size={13} />完成</button>
          </div>
        </div>}
      </div>;
    })}
  </div>;
}

function MessageActions({ onFork, forkDisabled = false, forking = false, copyText }: { onFork?: () => void; forkDisabled?: boolean; forking?: boolean; copyText?: string } = {}) {
  return <ActionBarPrimitive.Root className="message-actions">
    {copyText === undefined
      ? <ActionBarPrimitive.Copy className="ghost-icon" aria-label="复制"><Copy size={14} /><span>复制</span></ActionBarPrimitive.Copy>
      : <ReadableCopyButton text={copyText} />}
    {onFork && <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className="ghost-icon message-fork-action" type="button" aria-label="分支到新聊天" disabled={forkDisabled} onClick={onFork}>
          {forking ? <LoaderCircle className="spin" size={14} /> : <GitFork size={14} />}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content className="message-action-tooltip" side="top" sideOffset={7}>分支到新聊天</Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>}
  </ActionBarPrimitive.Root>;
}

function ReadableCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button
    className="ghost-icon"
    type="button"
    aria-label="复制"
    onClick={() => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2_000);
      }).catch(() => undefined);
    }}
  ><Copy size={14} /><span>{copied ? "已复制" : "复制"}</span></button>;
}

/** A long pasted brief collapses to this many lines until expanded. */
const PLAIN_TEXT_COLLAPSED_LINES = 12;

function LazyDirectiveChip({ directiveId, directiveType, label, projectId }: DirectiveChipProps & { projectId: string }) {
  if (isAttachmentDirectiveType(directiveType)) {
    return <AttachmentDirectiveChip directiveId={directiveId} directiveType={directiveType} label={label} projectId={projectId} composer />;
  }
  return <span className="generic-directive-chip">{label}</span>;
}

function AttachmentDirectiveChip({ directiveId, directiveType, label, projectId, composer = false }: {
  directiveId: string;
  directiveType: string;
  label: string;
  projectId: string;
  composer?: boolean;
}) {
  const source = parseReferenceAttachmentId(directiveId);
  const className = composer ? "attachment-directive-chip" : "sent-attachment-directive";
  const content = <><span className="attachment-directive-prefix">{attachmentDirectivePrefix(directiveType)}</span><span className="attachment-directive-label">{label}</span></>;
  if (!source) return <span className={className}>{content}</span>;
  return (
    <span
      className={`${className} is-source-link`}
      role="link"
      tabIndex={0}
      title={`${label}；打开来源对话`}
      onMouseDown={(event) => { if (composer) event.preventDefault(); }}
      onClick={() => openAttachmentSource(projectId, source.sessionId, source.turnIndex)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openAttachmentSource(projectId, source.sessionId, source.turnIndex);
      }}
    >{content}</span>
  );
}

function isAttachmentDirectiveType(type: string): boolean {
  return type === "attachment" || type === "session-attachment" || type === "project-attachment";
}

function attachmentDirectivePrefix(type: string): "@" | "@@" | "@@@" {
  if (type === "project-attachment") return "@@@";
  if (type === "session-attachment") return "@@";
  return "@";
}

function parseReferenceAttachmentId(id: string): { sessionId: string; turnIndex: number } | null {
  const match = id.match(/^lazyref-(?:session|project)-(.+)-(\d+)-[a-f0-9]{64}$/i);
  if (!match) return null;
  return { sessionId: match[1], turnIndex: Number(match[2]) };
}

function openAttachmentSource(projectId: string, sessionId: string, turnIndex: number): void {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("turn", String(turnIndex));
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

function renderUserText(text: string, projectId: string) {
  return unstable_defaultDirectiveFormatter.parse(text).map((segment, index) => segment.kind === "text"
    ? segment.text
    : isAttachmentDirectiveType(segment.type)
      ? <AttachmentDirectiveChip directiveId={segment.id} directiveType={segment.type} label={segment.label} projectId={projectId} key={`${segment.id}-${index}`} />
      : segment.label);
}

function readableUserText(text: string): string {
  return unstable_defaultDirectiveFormatter.parse(text).map((segment) => segment.kind === "text"
    ? segment.text
    : isAttachmentDirectiveType(segment.type)
      ? `${attachmentDirectivePrefix(segment.type)}${segment.label}`
      : segment.label).join("");
}

function PlainTextPart({ text, projectId }: TextMessagePartProps & { projectId: string }) {
  const bodyRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clampable, setClampable] = useState(false);

  // `scrollHeight` reports the full content height in both states (max-height +
  // overflow:hidden does not shrink it), so the same check is valid whether the
  // block is currently collapsed or expanded.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(node).lineHeight) || 24;
      setClampable(node.scrollHeight > lineHeight * PLAIN_TEXT_COLLAPSED_LINES + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className={`plain-message-block${clampable ? " is-clampable" : ""}${expanded ? " is-expanded" : ""}`}>
      <p className="plain-message" ref={bodyRef}>{renderUserText(text, projectId)}</p>
      {clampable && (
        <button
          type="button"
          className="plain-message-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : "展开"}
          <ChevronDown size={14} />
        </button>
      )}
    </div>
  );
}

const MarkdownPart = memo(function MarkdownPart({ text, status }: TextMessagePartProps) {
  // While the answer streams, a fenced block is still incomplete. Keeping the
  // preview closed avoids remounting the iframe on every token.
  const streaming = status?.type === "running";
  return (
    <div className="markdown-body" data-annotation-source="answer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...linkProps }) => <a {...linkProps} target="_blank" rel="noreferrer">{children}</a>,
          // Fenced blocks render through CodeBlock, which adds HTML preview and
          // copy. `pre` is unwrapped so the block is not nested inside a second
          // scrolling container.
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...codeProps }) => {
            const raw = String(children ?? "");
            const language = /language-([\w-]+)/.exec(className || "")?.[1] || "";
            const isBlock = Boolean(language) || raw.includes("\n");
            if (!isBlock) return <code className={className} {...codeProps}>{children}</code>;
            return <CodeBlock code={raw.replace(/\n$/, "")} language={language} streaming={streaming} />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}, (previous, next) => previous.text === next.text && previous.status?.type === next.status?.type);

function extractText(message: AppendMessage) {
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function convertUiMessage(message: UiMessage): ThreadMessageLike {
  const status = message.role === "assistant"
    ? message.status === "running" ? { type: "running" as const }
      : message.status === "stopped" ? { type: "incomplete" as const, reason: "cancelled" as const }
        : message.status === "error" ? { type: "incomplete" as const, reason: "error" as const }
          : { type: "complete" as const, reason: "stop" as const }
    : undefined;
  return {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.createdAt),
    status,
    content: message.role === "assistant"
      ? [
          { type: "data-lazy-timeline", data: { events: message.events || [], status: message.status } },
          { type: "text", text: message.text },
        ]
      : [
          ...(message.annotations?.length ? [{ type: "data-lazy-user-annotations" as const, data: { annotations: message.annotations } }] : []),
          ...(message.attachments?.length ? [{ type: "data-lazy-user-attachments" as const, data: { attachments: message.attachments } }] : []),
          ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
        ],
  };
}

function sessionToUiMessages(session: AgentSession): UiMessage[] {
  if (session.turns?.length) {
    return session.turns.flatMap((turn, index) => {
      const createdAt = turn.events?.[0]?.at || session.updatedAt || session.createdAt;
      return [
        { id: `${session.id}-user-${index}`, role: "user" as const, text: turn.userContent || "", annotations: turn.userAnnotations || [], attachments: withAttachmentUrls(session, turn.userAttachments), createdAt },
        {
          id: `${session.id}-assistant-${index}`,
          role: "assistant" as const,
          text: turn.finalAnswer || turn.partialAnswerText || "",
          createdAt,
          events: turn.events || [],
          status: turn.status,
          modelProvider: turn.modelProvider || session.modelProvider || DEFAULT_PROVIDER,
        },
      ];
    });
  }
  return (session.messages || [])
    .filter((message) => message.role === "user" || (message.role === "assistant" && message.content))
    .map((message) => ({
      id: message.id,
      role: message.role as "user" | "assistant",
      text: message.content,
      createdAt: message.createdAt,
      status: "completed" as const,
      modelProvider: message.role === "assistant" ? (message.modelProvider || session.modelProvider || DEFAULT_PROVIDER) : undefined,
      attachments: message.role === "user" ? withAttachmentUrls(session, message.attachments) : undefined,
    }));
}

function applyStreamBatch(messages: UiMessage[], batch: StreamEvent[], partialRef: React.MutableRefObject<string>) {
  return updateLiveAssistant(messages, (assistant) => {
    let next = { ...assistant, events: [...(assistant.events || [])] };
    for (const event of batch) {
      const data = event.data || {};
      if (["attachments_loaded", "thinking_start", "thinking_end", "reasoning_token", "assistant_text", "tool_call", "tool_result"].includes(event.type)) {
        const turnEvent: TurnEvent = { type: event.type, data, at: new Date().toISOString() };
        const last = next.events![next.events!.length - 1];
        if ((event.type === "reasoning_token" || event.type === "assistant_text") && last?.type === event.type) {
          last.data = { ...last.data, text: String(last.data.text || "") + String(data.text || "") };
        } else next.events!.push(turnEvent);
      }
      if (event.type === "thinking_discard") {
        const start = findLastEventIndex(next.events || [], "thinking_start");
        if (start >= 0) next.events = (next.events || []).slice(0, start);
      }
      if ((event.type === "answer_start" && data.preserveExisting !== true) || event.type === "answer_abort") next.text = "";
      if (event.type === "answer_delta" || event.type === "token_delta") next.text += String(data.text || "");
      if (event.type === "final") next.text = String(data.text || next.text);
      if (event.type === "error") { next.status = "error"; if (!next.text) next.text = `请求失败：${String(data.message || "未知错误")}`; }
      if (event.type === "confirmation") next.status = "stopped";
      if (event.type === "turn_info" && (data.status === "completed" || data.status === "stopped")) next.status = data.status;
      if (event.type === "done" && next.status === "running") next.status = "completed";
      if (event.type === "session" && isProviderName(data.modelProvider)) next.modelProvider = data.modelProvider;
    }
    partialRef.current = next.text;
    return next;
  });
}

function updateLiveAssistant(messages: UiMessage[], updater: (message: UiMessage) => UiMessage) {
  const index = [...messages].map((message) => message.role).lastIndexOf("assistant");
  if (index < 0) return messages;
  const next = [...messages];
  next[index] = updater(next[index]);
  return next;
}

function findLastEventIndex(events: TurnEvent[], type: string): number {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === type) return index;
  }
  return -1;
}

function withAttachmentUrls(session: AgentSession, attachments?: ImageAttachmentRef[]): ImageAttachmentRef[] | undefined {
  return attachments?.map((attachment) => ({
    ...attachment,
    previewUrl: `/api/session/attachment?projectId=${encodeURIComponent(session.projectId)}&sessionId=${encodeURIComponent(session.id)}&id=${encodeURIComponent(attachment.id)}`,
  }));
}

function projectFileContentUrl(projectId: string, fileId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/content`;
}

function normalizeBrowserMime(file: File): string {
  if (file.type) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function assignStableAttachmentLabels(
  attachments: ImageAttachmentRef[],
  nextLabel: AttachmentLabelState,
): ImageAttachmentRef[] {
  return attachments.map((attachment) => {
    const image = attachment.kind === "image" || attachment.mimeType.startsWith("image/");
    const kind = image ? "image" : "file";
    if (attachment.referenceScope) return { ...attachment, kind };
    const expected = attachment.label?.match(image ? /^图(\d+)$/ : /^文件(\d+)$/);
    if (expected) {
      nextLabel[kind] = Math.max(nextLabel[kind], Number(expected[1]) + 1);
      if (attachment.fileId && !nextLabel.byFileId.has(attachment.fileId)) {
        nextLabel.byFileId.set(attachment.fileId, attachment.label!);
      }
      return { ...attachment, kind };
    }
    const reused = attachment.fileId ? nextLabel.byFileId.get(attachment.fileId) : undefined;
    if (reused) return { ...attachment, kind, label: reused };
    const next = image ? nextLabel.image++ : nextLabel.file++;
    const label = image ? `图${next}` : `文件${next}`;
    if (attachment.fileId) nextLabel.byFileId.set(attachment.fileId, label);
    return { ...attachment, kind, label };
  });
}

function collectSessionAttachments(session: AgentSession): ImageAttachmentRef[] {
  return session.turns?.length
    ? session.turns.flatMap((turn) => turn.userAttachments || [])
    : session.messages.flatMap((message) => message.attachments || []);
}

function collectSessionReferenceAttachments(session: AgentSession): ImageAttachmentRef[] {
  const firstByFileId = new Map<string, ImageAttachmentRef>();
  const add = (attachment: ImageAttachmentRef, turnIndex: number, at: string) => {
    if (!attachment.fileId || !attachment.label || firstByFileId.has(attachment.fileId)) return;
    const sourceSessionId = attachment.sourceSessionId || session.id;
    const sourceTurnIndex = Number.isInteger(attachment.sourceTurnIndex) ? attachment.sourceTurnIndex! : turnIndex;
    firstByFileId.set(attachment.fileId, {
      ...attachment,
      id: referenceAttachmentId("session", sourceSessionId, sourceTurnIndex, attachment.fileId),
      referenceScope: "session",
      sourceSessionId,
      sourceSessionTitle: attachment.sourceSessionTitle || session.title || "未命名对话",
      sourceTurnIndex,
      sourceCreatedAt: attachment.sourceCreatedAt || at,
      previewUrl: projectFileContentUrl(session.projectId, attachment.fileId),
    });
  };

  if (session.turns?.length) {
    session.turns.forEach((turn, turnIndex) => {
      const at = turn.events?.[0]?.at || session.createdAt;
      turn.userAttachments?.forEach((attachment) => add(attachment, turnIndex, at));
    });
  } else {
    let turnIndex = -1;
    session.messages.forEach((message) => {
      if (message.role !== "user") return;
      turnIndex += 1;
      message.attachments?.forEach((attachment) => add(attachment, turnIndex, message.createdAt || session.createdAt));
    });
  }
  return [...firstByFileId.values()].sort((left, right) => String(right.sourceCreatedAt || "").localeCompare(String(left.sourceCreatedAt || "")));
}

function referenceAttachmentId(scope: "session" | "project", sessionId: string, turnIndex: number, fileId: string): string {
  return `lazyref-${scope}-${sessionId}-${turnIndex}-${fileId}`;
}

function selectOutgoingAttachments(text: string, attachments: ImageAttachmentRef[]): ImageAttachmentRef[] {
  const referencedIds = new Set(unstable_defaultDirectiveFormatter.parse(text).flatMap((segment) =>
    segment.kind === "mention" && isAttachmentDirectiveType(segment.type) ? [segment.id] : [],
  ));
  return attachments.filter((attachment) => !attachment.referenceScope || referencedIds.has(attachment.id));
}

function createAttachmentLabelState(attachments: ImageAttachmentRef[] = []): AttachmentLabelState {
  const state: AttachmentLabelState = { image: 1, file: 1, byFileId: new Map() };
  for (const attachment of attachments) {
    if (attachment.referenceScope) continue;
    const image = attachment.kind === "image" || attachment.mimeType.startsWith("image/");
    const kind = image ? "image" : "file";
    const match = attachment.label?.match(image ? /^图(\d+)$/ : /^文件(\d+)$/);
    if (match) state[kind] = Math.max(state[kind], Number(match[1]) + 1);
    if (attachment.fileId && attachment.label && !state.byFileId.has(attachment.fileId)) {
      state.byFileId.set(attachment.fileId, attachment.label);
    }
  }
  return state;
}

/** Resolves to null when the browser cannot decode the file; the server still validates. */
async function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

function draftKey(projectId: string, sessionId: string | null) { return `lazy:draft:${projectId}:${sessionId || "new"}`; }
function annotationDraftKey(projectId: string, sessionId: string | null) { return `lazy:annotations:${projectId}:${sessionId || "new"}`; }
function isDraftAnnotation(value: unknown): value is DraftAnnotation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DraftAnnotation>;
  return typeof item.id === "string"
    && Number.isInteger(item.sourceTurnIndex)
    && item.sourceKind === "answer"
    && typeof item.selectedText === "string"
    && typeof item.comment === "string"
    && typeof item.anchorRatio === "number";
}
function isSessionRunning(session?: AgentSession) { return session?.turns?.at(-1)?.status === "running"; }
