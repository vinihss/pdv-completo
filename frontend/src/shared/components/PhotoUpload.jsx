import React, { useRef, useEffect } from "react";
import { Camera, Trash2 } from "lucide-react";
import UserAvatar from "./UserAvatar.jsx";

/**
 * Componente de upload de foto reutilizável.
 * 
 * - Modo edição: botão de câmera sobre o avatar, upload imediato
 * - Modo criação: preview local antes de criar o usuário
 * - Reutiliza UserAvatar para manter consistência visual (login, menu, perfil)
 * 
 * Props:
 * - name: string (nome para as iniciais caso não tenha foto)
 * - photoPath: string | null (path da foto do servidor)
 * - preview: string | null (blob URL local para preview em criação)
 * - editable: boolean (mostra botão de câmera)
 * - busy: boolean (estado de loading)
 * - onPick: (file: File) => void (callback quando escolhe arquivo)
 * - onRemove: () => void (callback para remover foto)
 * - showRemove: boolean (mostra botão de remover)
 * - className: string (classes do avatar - tamanho, etc)
 * - removeLabel: string (texto do botão remover)
 */
export default function PhotoUpload({
  name,
  photoPath,
  preview,
  editable = true,
  busy = false,
  onPick,
  onRemove,
  showRemove = false,
  className = "",
  removeLabel = "Remover foto",
}) {
  const inputRef = useRef(null);

  // Revogar blob URL quando preview muda ou no unmount
  useEffect(() => {
    return () => {
      if (preview?.startsWith("blob:")) {
        URL.revokeObjectURL(preview);
      }
    };
  }, [preview]);

  const displayPhoto = preview || photoPath;

  return (
    <div className="relative shrink-0 self-start">
      <UserAvatar
        name={name}
        photoPath={displayPhoto}
        className={`w-16 h-16 text-lg border border-stone-700 ${className}`}
      />
      {editable && (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            aria-label="Enviar foto"
            title="Enviar foto"
            className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-amber-500 text-stone-950 flex items-center justify-center hover:bg-amber-400 disabled:opacity-50 transition-colors"
          >
            <Camera size={13} />
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              onPick(e.target.files?.[0]);
              e.target.value = "";
            }}
            disabled={busy}
          />
        </>
      )}
      {showRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={removeLabel}
          className="absolute -bottom-1 -left-1 w-7 h-7 rounded-full bg-red-500/90 text-white flex items-center justify-center hover:bg-red-500 disabled:opacity-50 transition-colors"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}