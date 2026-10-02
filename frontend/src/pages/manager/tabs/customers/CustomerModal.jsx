import React, { useState, useEffect, useRef } from "react";
import { Camera, Plus, Trash2, Star } from "lucide-react";
import {
  addCustomerAddress,
  createCustomer,
  cpfDigits,
  deleteCustomerAddress,
  getCustomer,
  removeCustomerPhoto,
  setDefaultCustomerAddress,
  updateCustomer,
  uploadCustomerPhoto,
  validarCpf,
} from "@/entities/customer";
import { Field, inputClass, Modal } from "@/shared/components";
import { formatAddress, initials, maskCep, maskCnpjCpf, maskPhone, maskState } from "@/shared/lib";
import { assetUrl } from "@/shared/lib/server";

// `cep` e `state` entraram junto: o endereço salvo pela página pública já os
// traz (migration 0005) e o gerente não podia-digitá-los aqui — o mesmo
// endereço acabava gravado com e sem UF, dependendo de onde foi cadastrado.
const EMPTY_ADDRESS = {
  label: "",
  cep: "",
  street: "",
  number: "",
  complement: "",
  neighborhood: "",
  city: "",
  state: "",
  reference: "",
};

function AddressRow({ customerId, address, onChange, showToast }) {
  async function handleSetDefault() {
    try {
      await setDefaultCustomerAddress(customerId, address.id);
      await onChange();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleDelete() {
    try {
      await deleteCustomerAddress(customerId, address.id);
      await onChange();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  return (
    <div className="bg-stone-800/40 border border-stone-700/60 rounded-xl px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm min-w-0">
          <div className="font-medium flex items-center gap-1.5">
            {address.isDefault && <Star size={11} className="text-amber-400 shrink-0" />}
            {address.label?.trim() || "Endereço"}
          </div>
          <div className="text-stone-400 text-xs mt-0.5">
            {formatAddress(address)}
            {address.reference ? ` (${address.reference})` : ""}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!address.isDefault && (
            <button
              onClick={handleSetDefault}
              title="Marcar como padrão"
              className="text-stone-500 hover:text-amber-400 p-1"
            >
              <Star size={14} />
            </button>
          )}
          <button onClick={handleDelete} title="Excluir endereço" className="text-stone-500 hover:text-red-400 p-1">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function PhotoPicker({ customer, busy, onPick, onRemove }) {
  const inputRef = useRef(null);
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0">
        {customer?.photoPath ? (
          <img
            src={assetUrl(customer.photoPath)}
            alt={customer.name}
            className="w-16 h-16 rounded-full object-cover border border-stone-700"
          />
        ) : (
          <div className="w-16 h-16 rounded-full bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-400 font-bold">
            {initials(customer?.name ?? "?")}
          </div>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          aria-label="Enviar foto"
          className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-amber-500 text-stone-950 flex items-center justify-center hover:bg-amber-400 disabled:opacity-50"
        >
          <Camera size={13} />
        </button>
        {/* `capture` faz o celular abrir a câmera direto em vez da galeria. */}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
      </div>
      <div className="text-xs text-stone-500 space-y-1">
        <p>Foto do cliente — identifica na comanda e no delivery.</p>
        {customer?.photoPath && (
          <button type="button" onClick={onRemove} disabled={busy} className="flex items-center gap-1 text-red-400 hover:text-red-300 disabled:opacity-50">
            <Trash2 size={12} /> Remover foto
          </button>
        )}
      </div>
    </div>
  );
}

export default function CustomerModal({ customer, onClose, onSaved, showToast }) {
  const isEdit = Boolean(customer);
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ? maskPhone(customer.phone) : "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [cpf, setCpf] = useState(customer?.cpf ? maskCnpjCpf(customer.cpf) : "");
  const [cpfError, setCpfError] = useState("");
  const [notes, setNotes] = useState(customer?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [addresses, setAddresses] = useState(customer?.addresses ?? []);
  const [addingAddress, setAddingAddress] = useState(false);
  const [newAddress, setNewAddress] = useState(EMPTY_ADDRESS);

  // A lista não traz endereços — o detalhe do cliente (com endereços) é
  // buscado ao abrir o modo edição.
  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    getCustomer(customer.id).then((detail) => {
      if (!cancelled) setAddresses(detail.addresses ?? []);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reloadAddresses() {
    if (!isEdit) return;
    const detail = await getCustomer(customer.id);
    setAddresses(detail.addresses ?? []);
  }

  // A foto sobe no `onChange`, sem esperar o PATCH do cadastro (mesmo padrão do
  // `UserModal`): o arquivo já está escolhido, e o servidor é quem manda.
  async function handlePickPhoto(file) {
    if (!file) return;
    setPhotoBusy(true);
    try {
      await uploadCustomerPhoto(customer.id, file);
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleRemovePhoto() {
    setPhotoBusy(true);
    try {
      await removeCustomerPhoto(customer.id);
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setPhotoBusy(false);
    }
  }

  function checkCpf() {
    const digits = cpfDigits(cpf);
    if (!digits) {
      setCpfError("");
      return true;
    }
    if (digits.length !== 11) {
      setCpfError("CPF incompleto — faltam dígitos.");
      return false;
    }
    if (!validarCpf(digits)) {
      setCpfError("CPF inválido — confira os dígitos verificadores.");
      return false;
    }
    setCpfError("");
    return true;
  }

  async function handleSubmit() {
    if (!name.trim()) {
      setError("Informe o nome do cliente.");
      return;
    }
    // O CPF é único no banco: avisar no campo é melhor do que deixar o POST
    // responder 409 depois de o gerente preencher o formulário inteiro.
    if (!checkCpf()) return;
    setError("");
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        cpf: cpfDigits(cpf) || null,
        notes: notes.trim() || null,
      };
      if (isEdit) await updateCustomer(customer.id, body);
      else await createCustomer(body);
      await onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddAddress() {
    if (!newAddress.street.trim() || !newAddress.number.trim() || !newAddress.neighborhood.trim() || !newAddress.city.trim()) {
      showToast("Informe rua, número, bairro e cidade.", "error");
      return;
    }
    try {
      await addCustomerAddress(customer.id, { ...newAddress, isDefault: addresses.length === 0 });
      setNewAddress(EMPTY_ADDRESS);
      setAddingAddress(false);
      await reloadAddresses();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  return (
    <Modal
      title={isEdit ? "Editar cliente" : "Novo cliente"}
      onClose={onClose}
      footer={
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl"
        >
          {saving ? "Salvando…" : isEdit ? "Salvar alterações" : "Criar cliente"}
        </button>
      }
    >
      <div className="p-5 space-y-4">
        {/* Foto só no modo edição: o upload é imediato e precisa do id, que
            cliente recem-criado ainda não tem. Quem acabou de cadastrar sai
            da lista, clica no card e encontra a foto aqui — e na ficha. */}
        {isEdit && <PhotoPicker customer={customer} busy={photoBusy} onPick={handlePickPhoto} onRemove={handleRemovePhoto} />}

        <Field label="Nome" required>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setError(""); }}
            className={inputClass + (error && !name.trim() ? " border-red-500/60" : "")}
            autoFocus
          />
        </Field>

        <Field label="Telefone">
          <input
            value={phone}
            onChange={(e) => setPhone(maskPhone(e.target.value))}
            placeholder="(11) 99999-0000"
            inputMode="tel"
            className={inputClass}
          />
        </Field>

        <Field label="Email">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="cliente@exemplo.com"
            inputMode="email"
            className={inputClass}
          />
        </Field>

        <div>
          <Field label="CPF (opcional)">
            <input
              value={cpf}
              onChange={(e) => { setCpf(maskCnpjCpf(e.target.value)); if (cpfError) setCpfError(""); }}
              placeholder="000.000.000-00"
              inputMode="numeric"
              autoComplete="off"
              className={inputClass + (cpfError ? " border-red-500/60" : "")}
            />
          </Field>
          {cpfError && <p className="text-red-400 text-xs mt-1.5">{cpfError}</p>}
        </div>

        <Field label="Observações">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Anotação interna: preferência, restrição, nome da pessoa que pede..."
            className={inputClass + " resize-y"}
          />
        </Field>

        {error && <p className="text-red-400 text-xs">{error}</p>}

        {isEdit && (
          <div className="space-y-2 pt-1">
            <div className="text-xs font-bold uppercase tracking-widest text-stone-500">
              Endereços ({addresses.length}/3)
            </div>
            <div className="space-y-2">
              {addresses.map((a) => (
                <AddressRow key={a.id} customerId={customer.id} address={a} onChange={reloadAddresses} showToast={showToast} />
              ))}
              {addresses.length === 0 && !addingAddress && (
                <p className="text-stone-600 text-xs">Nenhum endereço cadastrado.</p>
              )}
            </div>
            {addingAddress ? (
              <div className="bg-stone-900 border border-stone-700 rounded-xl p-3 space-y-2">
                <Field label="Rótulo (opcional)">
                  <input
                    value={newAddress.label}
                    onChange={(e) => setNewAddress({ ...newAddress, label: e.target.value })}
                    placeholder="Casa, Trabalho..."
                    className={inputClass}
                  />
                </Field>
                <Field label="CEP">
                  <input
                    value={newAddress.cep}
                    onChange={(e) => setNewAddress({ ...newAddress, cep: maskCep(e.target.value) })}
                    placeholder="00000-000"
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={9}
                    className={inputClass}
                  />
                </Field>
                <div className="grid grid-cols-[1fr_90px] gap-2">
                  <Field label="Rua" required>
                    <input
                      value={newAddress.street}
                      onChange={(e) => setNewAddress({ ...newAddress, street: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Número" required>
                    <input
                      value={newAddress.number}
                      onChange={(e) => setNewAddress({ ...newAddress, number: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                </div>
                <Field label="Complemento">
                  <input
                    value={newAddress.complement}
                    onChange={(e) => setNewAddress({ ...newAddress, complement: e.target.value })}
                    placeholder="Apto, bloco..."
                    className={inputClass}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Bairro" required>
                    <input
                      value={newAddress.neighborhood}
                      onChange={(e) => setNewAddress({ ...newAddress, neighborhood: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                  <div className="grid grid-cols-[1fr_70px] gap-2">
                    <Field label="Cidade" required>
                      <input
                        value={newAddress.city}
                        onChange={(e) => setNewAddress({ ...newAddress, city: e.target.value })}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="UF">
                      <input
                        value={newAddress.state}
                        onChange={(e) => setNewAddress({ ...newAddress, state: maskState(e.target.value) })}
                        placeholder="UF"
                        inputMode="text"
                        maxLength={2}
                        autoComplete="address-level1"
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </div>
                <Field label="Ponto de referência">
                  <input
                    value={newAddress.reference}
                    onChange={(e) => setNewAddress({ ...newAddress, reference: e.target.value })}
                    className={inputClass}
                  />
                </Field>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleAddAddress}
                    className="flex-1 bg-amber-500 hover:bg-amber-400 text-stone-950 text-sm font-semibold py-2.5 rounded-xl"
                  >
                    Salvar endereço
                  </button>
                  <button
                    onClick={() => { setAddingAddress(false); setNewAddress(EMPTY_ADDRESS); }}
                    className="px-4 text-sm font-semibold text-stone-400 hover:text-stone-200"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              addresses.length < 3 && (
                <button
                  onClick={() => setAddingAddress(true)}
                  className="w-full flex items-center justify-center gap-2 border border-dashed border-stone-700 text-stone-400 hover:text-amber-400 hover:border-amber-500/40 text-sm font-semibold py-2.5 rounded-xl"
                >
                  <Plus size={15} /> Adicionar endereço
                </button>
              )
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
