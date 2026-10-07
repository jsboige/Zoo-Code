import * as vscode from "vscode"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"
import * as fs from "fs/promises"

import { Package } from "../shared/package"
import { fileExistsAtPath } from "./fs"
import { t } from "../i18n"

import { importSettingsFromPath, ImportOptions } from "../core/config/importExport"

// Key used to store the hash of the last successfully imported settings file in globalState.
// It is only used to decide whether the success notification is worth raising: the import
// itself runs on every activation on purpose (see below).
// Deliberately kept out of ContextProxy/GlobalState: this is internal bookkeeping, not a
// user-facing setting, and it must not leak into the export/import settings schema.
const LAST_IMPORT_HASH_KEY = "zooCode.lastAutoImportHash"

function sha256Hex(s: string): string {
	return crypto.createHash("sha256").update(s, "utf-8").digest("hex")
}

export type AutoImportOptions = ImportOptions & {
	/** Extension context, used to remember the last imported file hash across activations. */
	context: vscode.ExtensionContext
}

/**
 * Automatically imports RooCode settings from a specified path if it exists.
 * This function is called during extension activation to allow users to pre-configure
 * their settings by placing a settings file at a predefined location.
 */
export async function autoImportSettings(
	outputChannel: vscode.OutputChannel,
	{ providerSettingsManager, contextProxy, customModesManager, context }: AutoImportOptions,
): Promise<void> {
	try {
		// Get the auto-import settings path from VSCode settings
		const settingsPath = vscode.workspace.getConfiguration(Package.name).get<string>("autoImportSettingsPath")

		if (!settingsPath || settingsPath.trim() === "") {
			outputChannel.appendLine("[AutoImport] No auto-import settings path specified, skipping auto-import")
			return
		}

		// Resolve the path (handle ~ for home directory and relative paths)
		const resolvedPath = resolvePath(settingsPath.trim())
		outputChannel.appendLine(`[AutoImport] Checking for settings file at: ${resolvedPath}`)

		// Check if the file exists
		if (!(await fileExistsAtPath(resolvedPath))) {
			outputChannel.appendLine(`[AutoImport] Settings file not found at ${resolvedPath}, skipping auto-import`)
			return
		}

		// Hash the file so we can tell whether it changed since the last successful import.
		// The import below still runs on EVERY activation on purpose: it is the self-healing
		// path that re-asserts a known-good config after Zoo flushes its in-memory state on
		// exit (the durable fix for that race is the autoImport path itself). Skipping an
		// unchanged import would defeat it, so only the notification is gated.
		const fileContent = await fs.readFile(resolvedPath, "utf-8")
		const fileHash = sha256Hex(fileContent)
		const lastImportHash = context.globalState.get<string>(LAST_IMPORT_HASH_KEY)
		const contentUnchanged = lastImportHash !== undefined && lastImportHash === fileHash

		// Attempt to import the configuration
		const result = await importSettingsFromPath(resolvedPath, {
			providerSettingsManager,
			contextProxy,
			customModesManager,
		})

		if (result.success) {
			outputChannel.appendLine(`[AutoImport] Successfully imported settings from ${resolvedPath}`)

			// Remember the imported hash so the next activation recognises an unchanged file
			try {
				await context.globalState.update(LAST_IMPORT_HASH_KEY, fileHash)
			} catch {
				// Non-fatal: a missing/broken globalState never blocks the import itself
			}

			if (result.warnings && result.warnings.length > 0) {
				const count = result.warnings.length
				outputChannel.appendLine(
					`[AutoImport] Import completed with ${count} warning${count === 1 ? "" : "s"}.`,
				)
				for (const warning of result.warnings) {
					outputChannel.appendLine(`[AutoImport] Warning: ${warning}`)
				}
			}

			// Only notify when the config actually changed: re-applying an unchanged file is
			// deliberate (see above), but raising a toast for it on every restart is not.
			if (contentUnchanged) {
				outputChannel.appendLine(
					`[AutoImport] Settings unchanged since last import; re-applied without notification`,
				)
			} else {
				vscode.window.showInformationMessage(
					t("common:info.auto_import_success", { filename: path.basename(resolvedPath) }),
				)
			}
		} else {
			outputChannel.appendLine(`[AutoImport] Failed to import settings: ${result.error}`)

			// Show a warning but don't fail the extension activation
			vscode.window.showWarningMessage(t("common:warnings.auto_import_failed", { error: result.error }))
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		outputChannel.appendLine(`[AutoImport] Unexpected error during auto-import: ${errorMessage}`)

		// Log error but don't fail extension activation
		console.warn("Auto-import settings error:", error)
	}
}

/**
 * Resolves a file path, handling home directory expansion and relative paths
 */
function resolvePath(settingsPath: string): string {
	// Handle home directory expansion
	if (settingsPath.startsWith("~/")) {
		return path.join(os.homedir(), settingsPath.slice(2))
	}

	// Handle absolute paths
	if (path.isAbsolute(settingsPath)) {
		return settingsPath
	}

	// Handle relative paths (relative to home directory for safety)
	return path.join(os.homedir(), settingsPath)
}
