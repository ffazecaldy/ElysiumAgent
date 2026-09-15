# Versione LENTA: loop O(n^2) naive
def compute():
    total = 0
    for i in range(2000):
        for j in range(2000):
            total += i * j
    return total

if __name__ == "__main__":
    print(compute())
