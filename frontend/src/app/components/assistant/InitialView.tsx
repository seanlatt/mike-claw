"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { MikeIcon } from "@/components/chat/mike-icon";
import { ChatInput } from "./ChatInput";
import { SelectAssistantProjectModal } from "./SelectAssistantProjectModal";
import { intakeDocument } from "@/app/lib/mikeApi";
import type { MikeMessage } from "../shared/types";

interface InitialViewProps {
    onSubmit: (message: MikeMessage) => void;
}

const ICON_SIZE = 35;
const GAP = 16; // gap-4 = 1rem = 16px

export function InitialView({ onSubmit }: InitialViewProps) {
    const router = useRouter();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const [loaded, setLoaded] = useState(false);
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const [iconOffset, setIconOffset] = useState(0);
    const [textOffset, setTextOffset] = useState(0);
    const [dragOver, setDragOver] = useState(false);
    const [intakeState, setIntakeState] = useState<{
        phase: "idle" | "uploading" | "classifying" | "error";
        message: string;
    }>({ phase: "idle", message: "" });
    const textRef = useRef<HTMLHeadingElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    async function runIntake(file: File): Promise<void> {
        setIntakeState({
            phase: "uploading",
            message: `Reading ${file.name}…`,
        });
        try {
            // The backend does both upload + OpenClaw classification in one
            // request — switch to "classifying" right after the upload
            // bytes are sent so the user knows the agent is thinking.
            setTimeout(() => {
                setIntakeState((prev) =>
                    prev.phase === "uploading"
                        ? {
                              phase: "classifying",
                              message: "OpenClaw is organizing your matter…",
                          }
                        : prev,
                );
            }, 800);

            const result = await intakeDocument(file);
            // Bust Next.js's router cache so the Projects list refreshes
            // when the user later navigates there.
            router.refresh();
            // Navigate straight into the new matter.
            router.push(`/projects/${result.project_id}`);
        } catch (err) {
            setIntakeState({
                phase: "error",
                message:
                    err instanceof Error ? err.message : String(err),
            });
        }
    }

    function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void runIntake(file);
    }

    function handleFilePicked(
        e: React.ChangeEvent<HTMLInputElement>,
    ): void {
        const file = e.target.files?.[0];
        if (file) void runIntake(file);
        // Reset so the same file can be picked twice in a row.
        e.target.value = "";
    }

    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";

    useLayoutEffect(() => {
        if (!profile || !textRef.current) return;
        const h1Width = textRef.current.offsetWidth;
        setIconOffset((h1Width + GAP) / 2);
        setTextOffset((ICON_SIZE + GAP) / 2);
    }, [profile]);

    useEffect(() => {
        if (!iconOffset) return;
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, [iconOffset]);

    return (
        <div className="flex flex-col h-full w-full px-6">
            <div className="flex-1 flex flex-col items-center justify-center">
                <div className="flex-col items-center w-full max-w-4xl relative px-0 xl:px-8">
                    <div className="mb-10 relative flex items-center justify-center">
                        <div
                            className="absolute h-[35px]"
                            style={{
                                left: "50%",
                                transform: loaded
                                    ? `translateX(calc(-50% - ${iconOffset}px))`
                                    : "translateX(-50%)",
                                transition:
                                    "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                            }}
                        >
                            <MikeIcon size={ICON_SIZE} />
                        </div>
                        <h1
                            ref={textRef}
                            className="absolute text-4xl font-serif font-light text-gray-900 whitespace-nowrap"
                            style={{
                                left: "50%",
                                transform: loaded
                                    ? `translateX(calc(-50% + ${textOffset}px))`
                                    : "translateX(-50%)",
                                opacity: loaded ? 1 : 0,
                                transition:
                                    "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 800ms ease-in-out 300ms",
                            }}
                        >
                            Hi, {username}
                        </h1>
                    </div>

                    <div
                        onDragOver={(e) => {
                            e.preventDefault();
                            setDragOver(true);
                        }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={handleDrop}
                        className={`mb-4 rounded-xl border-2 border-dashed transition-colors ${
                            dragOver
                                ? "border-gray-700 bg-gray-50"
                                : "border-gray-200"
                        } ${
                            intakeState.phase === "uploading" ||
                            intakeState.phase === "classifying"
                                ? "opacity-80"
                                : ""
                        }`}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf,.docx,.doc"
                            className="hidden"
                            onChange={handleFilePicked}
                        />
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={
                                intakeState.phase === "uploading" ||
                                intakeState.phase === "classifying"
                            }
                            className="w-full text-left px-5 py-4 flex items-center gap-3 hover:bg-gray-50 disabled:cursor-not-allowed disabled:hover:bg-transparent rounded-xl"
                        >
                            <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-base">
                                {intakeState.phase === "classifying"
                                    ? "🦞"
                                    : "📄"}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-gray-900">
                                    {intakeState.phase === "uploading"
                                        ? "Uploading…"
                                        : intakeState.phase === "classifying"
                                          ? "OpenClaw is organizing your matter…"
                                          : intakeState.phase === "error"
                                            ? "Intake failed"
                                            : "Drop a contract to auto-organize"}
                                </div>
                                <div className="text-xs text-gray-500 truncate">
                                    {intakeState.phase === "error"
                                        ? intakeState.message
                                        : intakeState.phase === "idle"
                                          ? "PDF, DOCX. We classify it and create a matter for you."
                                          : intakeState.message}
                                </div>
                            </div>
                        </button>
                    </div>

                    <ChatInput
                        onSubmit={onSubmit}
                        onCancel={() => {}}
                        isLoading={false}
                        onProjectsClick={() => setProjectModalOpen(true)}
                    />

                    <div className="text-center">
                        <p className="text-xs py-3 mb-3 text-gray-500">
                            AI can make mistakes. Answers are not legal advice.
                        </p>
                    </div>
                </div>
            </div>

            <SelectAssistantProjectModal
                open={projectModalOpen}
                onClose={() => setProjectModalOpen(false)}
            />
        </div>
    );
}
