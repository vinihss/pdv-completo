// Lançamento de itens — porta RN do AddItemScreen web. Categorias + produtos,
// variações em overlay, cartão com revisão persistido em `cartStorage` (por
// comanda, sombre o adapter de storage do app). A confirmação faz o POST e
// volta para o detalhe — que recarrega ao ganhar foco (useFocusEffect).
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/app/providers/auth";
import { addItems } from "@/entities/order";
import { formatBRL } from "@/shared/lib";
import { listAllProducts, listCategories } from "./api/catalog.js";
import {
  addLine,
  cartCount,
  cartTotal,
  changeNotes,
  hasVariations,
  productQty,
  removeLine,
  toServerItems,
} from "./model/cartLogic.js";
import { clearCart, loadCart, saveCart } from "./model/cartStorage.js";
import VariationModal from "./ui/VariationModal.jsx";
import ReviewCartModal from "./ui/ReviewCartModal.jsx";

const ROW_GAP = 10;

export default function AddItemScreen({ route, navigation }) {
  const orderId = route.params?.orderId;
  const { storeSettings } = useAuth();
  const stockEnabled = storeSettings?.inventoryEnabled ?? false;

  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState(null);
  const [variationModal, setVariationModal] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    listCategories()
      .then(setCategories)
      .catch(() => {});
    listAllProducts({ active: "true" })
      .then(({ data }) => setProducts(data))
      .catch(() => {});
    setCart(loadCart(orderId) ?? {});
  }, [orderId]);

  const filteredProducts = useMemo(
    () =>
      products.filter((p) => {
        if (activeCategory && p.categoryId !== activeCategory) return false;
        if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      }),
    [products, activeCategory, search]
  );

  function updateCart(updater) {
    setCart((prev) => {
      const next = updater(prev);
      saveCart(orderId, next);
      return next;
    });
  }

  function handleProductTap(product) {
    if (hasVariations(product)) {
      setVariationModal(product);
    } else {
      updateCart((prev) => addLine(prev, product));
    }
  }

  const count = cartCount(cart);
  const total = cartTotal(cart);

  async function handleConfirmBatch() {
    setConfirming(true);
    setError(null);
    try {
      await addItems(orderId, toServerItems(cart));
      clearCart(orderId);
      navigation.goBack();
    } catch (e) {
      setConfirming(false);
      setError(e.message);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color="#57534e" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Buscar produto..."
            placeholderTextColor="#57534e"
            style={styles.searchInput}
          />
        </View>
        <FlatList
          horizontal
          data={[{ id: "all", name: "Todos" }, ...categories]}
          keyExtractor={(c) => c.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categories}
          renderItem={({ item: c }) => {
            const active = (activeCategory ?? "all") === c.id;
            return (
              <Pressable
                onPress={() => setActiveCategory(c.id === "all" ? null : c.id)}
                style={[styles.categoryTab, active && styles.categoryTabActive]}
                accessibilityRole="button"
              >
                <Text style={[styles.categoryLabel, active && styles.categoryLabelActive]}>{c.name}</Text>
              </Pressable>
            );
          }}
        />
      </View>

      <FlatList
        data={filteredProducts}
        keyExtractor={(p) => p.id}
        numColumns={2}
        columnWrapperStyle={{ gap: ROW_GAP }}
        contentContainerStyle={styles.grid}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>Nenhum produto encontrado.</Text>
          </View>
        }
        renderItem={({ item: p }) => {
          const addedQty = productQty(cart, p.id);
          const outOfStock = stockEnabled && p.trackStock && p.quantity <= 0;
          return (
            <Pressable
              disabled={outOfStock}
              onPress={() => !outOfStock && handleProductTap(p)}
              style={[
                styles.product,
                addedQty > 0 && !outOfStock && styles.productAdded,
                outOfStock && styles.productOut,
              ]}
              accessibilityRole="button"
            >
              {addedQty > 0 && !outOfStock && (
                <View style={styles.qtyBadge}>
                  <Text style={styles.qtyBadgeLabel}>{addedQty}</Text>
                </View>
              )}
              <Text style={styles.productName} numberOfLines={2}>
                {p.name}
              </Text>
              <Text style={styles.productPrice}>{formatBRL(p.price)}</Text>
              {p.description ? (
                <Text style={styles.productDesc} numberOfLines={2}>
                  {p.description}
                </Text>
              ) : null}
              {hasVariations(p) && <Text style={styles.productOptions}>Opções disponíveis</Text>}
              {outOfStock && (
                <View style={styles.outRow}>
                  <Ionicons name="alert-circle" size={12} color="#f87171" />
                  <Text style={styles.outLabel}>Sem estoque</Text>
                </View>
              )}
            </Pressable>
          );
        }}
      />

      {count > 0 && (
        <View style={styles.cartBar}>
          {error && (
            <Text style={styles.errorText} numberOfLines={2}>
              {error}
            </Text>
          )}
          <Pressable
            onPress={() => setReviewOpen(true)}
            disabled={confirming}
            style={styles.cartButton}
            accessibilityRole="button"
          >
            <View style={styles.cartLeft}>
              <Ionicons name="checkmark-circle" size={20} color="#022c22" />
              <Text style={styles.cartCount}>
                {count} {count === 1 ? "item" : "itens"} · {formatBRL(total)}
              </Text>
            </View>
            <Text style={styles.cartReview}>Revisar e confirmar →</Text>
          </Pressable>
        </View>
      )}

      {variationModal && (
        <VariationModal
          product={variationModal}
          onClose={() => setVariationModal(null)}
          onConfirm={(selection) => {
            updateCart((prev) => addLine(prev, variationModal, selection));
            setVariationModal(null);
          }}
        />
      )}

      {reviewOpen && (
        <ReviewCartModal
          lines={Object.values(cart ?? {})}
          total={total}
          onClose={() => setReviewOpen(false)}
          onRemoveLine={(key) => updateCart((prev) => removeLine(prev, key))}
          onChangeNotes={(key, notes) => updateCart((prev) => changeNotes(prev, key, notes))}
          onConfirm={handleConfirmBatch}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0c0a09",
  },
  toolbar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#1c1917",
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    color: "#fafaf9",
    fontSize: 14,
    paddingVertical: 9,
  },
  categories: {
    gap: 8,
    paddingRight: 16,
  },
  categoryTab: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  categoryTabActive: {
    backgroundColor: "#f59e0b",
    borderColor: "#f59e0b",
  },
  categoryLabel: {
    color: "#a8a29e",
    fontSize: 12,
    fontWeight: "600",
  },
  categoryLabelActive: {
    color: "#1c1917",
  },
  grid: {
    padding: 16,
    gap: ROW_GAP,
    paddingBottom: 96,
  },
  emptyBox: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 48,
  },
  emptyText: {
    color: "#57534e",
    fontSize: 14,
  },
  product: {
    flex: 1,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 16,
    padding: 14,
    gap: 4,
  },
  productAdded: {
    backgroundColor: "rgba(16,185,129,0.1)",
    borderColor: "rgba(16,185,129,0.5)",
  },
  productOut: {
    opacity: 0.45,
  },
  qtyBadge: {
    position: "absolute",
    top: 10,
    right: 10,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#10b981",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
    zIndex: 1,
  },
  qtyBadgeLabel: {
    color: "#022c22",
    fontSize: 12,
    fontWeight: "800",
  },
  productName: {
    color: "#fafaf9",
    fontSize: 15,
    fontWeight: "600",
  },
  productPrice: {
    color: "#34d399",
    fontSize: 14,
    fontWeight: "700",
  },
  productDesc: {
    color: "#78716c",
    fontSize: 12,
  },
  productOptions: {
    color: "#78716c",
    fontSize: 12,
    marginTop: 2,
  },
  outRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  outLabel: {
    color: "#f87171",
    fontSize: 12,
    fontWeight: "700",
  },
  cartBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: "#292524",
    backgroundColor: "#1c1917",
  },
  cartButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#10b981",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  cartLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  cartCount: {
    color: "#022c22",
    fontSize: 14,
    fontWeight: "700",
  },
  cartReview: {
    color: "#022c22",
    fontSize: 13,
    fontWeight: "600",
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
    marginBottom: 8,
    lineHeight: 18,
  },
});