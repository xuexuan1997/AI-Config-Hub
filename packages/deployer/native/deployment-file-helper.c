#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef __linux__
#error "deployment-file-helper is Linux-only"
#endif

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif

enum { EXIT_CONFLICT = 20, EXIT_PATH = 21, EXIT_DURABILITY = 22, EXIT_INTERNAL = 23 };

typedef struct {
  uint32_t state[8];
  uint64_t bits;
  unsigned char block[64];
  size_t used;
} Sha256;

static const uint32_t sha_k[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

static uint32_t rotate_right(uint32_t value, unsigned count) {
  return (value >> count) | (value << (32U - count));
}

static void sha_transform(Sha256 *ctx) {
  uint32_t words[64];
  for (size_t index = 0; index < 16; index++) {
    const unsigned char *part = ctx->block + index * 4;
    words[index] = ((uint32_t)part[0] << 24) | ((uint32_t)part[1] << 16) |
                   ((uint32_t)part[2] << 8) | part[3];
  }
  for (size_t index = 16; index < 64; index++) {
    uint32_t s0 = rotate_right(words[index - 15], 7) ^ rotate_right(words[index - 15], 18) ^
                  (words[index - 15] >> 3);
    uint32_t s1 = rotate_right(words[index - 2], 17) ^ rotate_right(words[index - 2], 19) ^
                  (words[index - 2] >> 10);
    words[index] = words[index - 16] + s0 + words[index - 7] + s1;
  }
  uint32_t a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
  uint32_t e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];
  for (size_t index = 0; index < 64; index++) {
    uint32_t s1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
    uint32_t choice = (e & f) ^ (~e & g);
    uint32_t first = h + s1 + choice + sha_k[index] + words[index];
    uint32_t s0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t second = s0 + majority;
    h = g; g = f; f = e; e = d + first; d = c; c = b; b = a; a = first + second;
  }
  ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c; ctx->state[3] += d;
  ctx->state[4] += e; ctx->state[5] += f; ctx->state[6] += g; ctx->state[7] += h;
}

static void sha_init(Sha256 *ctx) {
  const uint32_t initial[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                               0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  memcpy(ctx->state, initial, sizeof(initial));
  ctx->bits = 0; ctx->used = 0;
}

static void sha_update(Sha256 *ctx, const unsigned char *bytes, size_t length) {
  ctx->bits += (uint64_t)length * 8;
  while (length > 0) {
    size_t available = 64 - ctx->used;
    size_t count = length < available ? length : available;
    memcpy(ctx->block + ctx->used, bytes, count);
    ctx->used += count; bytes += count; length -= count;
    if (ctx->used == 64) { sha_transform(ctx); ctx->used = 0; }
  }
}

static void sha_finish(Sha256 *ctx, char output[72]) {
  ctx->block[ctx->used++] = 0x80;
  if (ctx->used > 56) { memset(ctx->block + ctx->used, 0, 64 - ctx->used); sha_transform(ctx); ctx->used = 0; }
  memset(ctx->block + ctx->used, 0, 56 - ctx->used);
  for (size_t index = 0; index < 8; index++) ctx->block[63 - index] = (unsigned char)(ctx->bits >> (index * 8));
  sha_transform(ctx);
  memcpy(output, "sha256:", 7);
  for (size_t index = 0; index < 8; index++) sprintf(output + 7 + index * 8, "%08x", ctx->state[index]);
  output[71] = '\0';
}

static int valid_segment(const char *segment) {
  return segment[0] != '\0' && strcmp(segment, ".") != 0 && strcmp(segment, "..") != 0;
}

static int open_absolute_root(const char *path, int create) {
  if (path[0] != '/') { errno = EINVAL; return -1; }
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) return -1;
  char *copy = strdup(path + 1);
  if (copy == NULL) { close(current); return -1; }
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part != NULL; part = strtok_r(NULL, "/", &save)) {
    if (!valid_segment(part)) { errno = EINVAL; goto fail; }
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0 && create && errno == ENOENT) {
      if (mkdirat(current, part, 0700) < 0 && errno != EEXIST) goto fail;
      next = openat(current, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    }
    if (next < 0) goto fail;
    close(current); current = next;
  }
  free(copy); return current;
fail:
  free(copy); close(current); return -1;
}

static int open_parent(int root, const char *relative_path, int create, char **leaf) {
  if (relative_path[0] == '/' || relative_path[0] == '\0') { errno = EINVAL; return -1; }
  char *copy = strdup(relative_path);
  if (copy == NULL) return -1;
  int current = dup(root);
  if (current < 0) { free(copy); return -1; }
  char *save = NULL;
  char *part = strtok_r(copy, "/", &save);
  while (part != NULL) {
    char *next_part = strtok_r(NULL, "/", &save);
    if (!valid_segment(part)) { errno = EINVAL; goto fail; }
    if (next_part == NULL) {
      *leaf = strdup(part);
      free(copy);
      if (*leaf == NULL) { close(current); return -1; }
      return current;
    }
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0 && create && errno == ENOENT) {
      if (mkdirat(current, part, 0700) < 0 && errno != EEXIST) goto fail;
      next = openat(current, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    }
    if (next < 0) goto fail;
    close(current); current = next; part = next_part;
  }
fail:
  free(copy); close(current); return -1;
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_size == right->st_size && left->st_mtim.tv_sec == right->st_mtim.tv_sec &&
         left->st_mtim.tv_nsec == right->st_mtim.tv_nsec;
}

static int hash_fd(int fd, char output[72]) {
  if (lseek(fd, 0, SEEK_SET) < 0) return -1;
  Sha256 hash; sha_init(&hash);
  unsigned char buffer[65536];
  for (;;) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0) { if (errno == EINTR) continue; return -1; }
    if (count == 0) break;
    sha_update(&hash, buffer, (size_t)count);
  }
  sha_finish(&hash, output); return 0;
}

static int verify_open_target(int parent, const char *leaf, const char *expected, int *fd, struct stat *identity) {
  *fd = openat(parent, leaf, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (*fd < 0) return errno == ENOENT ? EXIT_CONFLICT : EXIT_PATH;
  if (fstat(*fd, identity) < 0 || !S_ISREG(identity->st_mode)) return EXIT_PATH;
  char actual[72];
  if (hash_fd(*fd, actual) < 0) return EXIT_INTERNAL;
  return strcmp(actual, expected) == 0 ? 0 : EXIT_CONFLICT;
}

static int identity_still_matches(int parent, const char *leaf, const struct stat *identity) {
  struct stat current;
  return fstatat(parent, leaf, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
         S_ISREG(current.st_mode) && same_identity(identity, &current);
}

static int sync_parent(int parent) {
  if (getenv("AICH_TEST_FAIL_PARENT_FSYNC") != NULL) { errno = EIO; return -1; }
  return fsync(parent);
}

static int test_pause_before_commit(void) {
  const char *marker = getenv("AICH_TEST_PAUSE_BEFORE_COMMIT");
  if (marker == NULL) return 0;
  int signal_fd = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (signal_fd < 0) return -1;
  close(signal_fd);
  size_t length = strlen(marker) + 10;
  char *continuation = malloc(length);
  if (continuation == NULL) return -1;
  snprintf(continuation, length, "%s.continue", marker);
  for (int attempt = 0; attempt < 10000; attempt++) {
    if (access(continuation, F_OK) == 0) { free(continuation); return 0; }
    if (errno != ENOENT) { free(continuation); return -1; }
    usleep(1000);
  }
  free(continuation); errno = ETIMEDOUT; return -1;
}

static int write_stdin_to_temp(int parent, const char *temp, mode_t mode, char hash_output[72]) {
  int fd = openat(parent, temp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return -1;
  Sha256 hash; sha_init(&hash);
  unsigned char buffer[65536];
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count < 0) { if (errno == EINTR) continue; close(fd); return -1; }
    if (count == 0) break;
    sha_update(&hash, buffer, (size_t)count);
    size_t offset = 0;
    while (offset < (size_t)count) {
      ssize_t written = write(fd, buffer + offset, (size_t)count - offset);
      if (written < 0) { if (errno == EINTR) continue; close(fd); return -1; }
      offset += (size_t)written;
    }
  }
  if (fchmod(fd, mode) < 0 || fsync(fd) < 0 || close(fd) < 0) return -1;
  sha_finish(&hash, hash_output); return 0;
}

static int replace_file(const char *root_path, const char *relative_path, const char *expected) {
  int root = open_absolute_root(root_path, 0);
  if (root < 0) return EXIT_PATH;
  char *leaf = NULL;
  int parent = open_parent(root, relative_path, strcmp(expected, "absent") == 0, &leaf);
  close(root);
  if (parent < 0) return EXIT_PATH;
  char temp[80]; snprintf(temp, sizeof(temp), ".aich-%ld.tmp", (long)getpid());
  char resulting_hash[72];
  if (write_stdin_to_temp(parent, temp, 0600, resulting_hash) < 0) goto internal;
  if (strcmp(expected, "absent") == 0) {
    if (test_pause_before_commit() < 0) goto internal;
    if (syscall(SYS_renameat2, parent, temp, parent, leaf, RENAME_NOREPLACE) < 0) {
      int code = errno == EEXIST ? EXIT_CONFLICT : EXIT_INTERNAL;
      unlinkat(parent, temp, 0); free(leaf); close(parent); return code;
    }
  } else {
    int target = -1; struct stat identity;
    int code = verify_open_target(parent, leaf, expected, &target, &identity);
    if (code != 0) { if (target >= 0) close(target); unlinkat(parent, temp, 0); free(leaf); close(parent); return code; }
    if (test_pause_before_commit() < 0) { close(target); goto internal; }
    if (!identity_still_matches(parent, leaf, &identity)) { close(target); unlinkat(parent, temp, 0); free(leaf); close(parent); return EXIT_CONFLICT; }
    close(target);
    if (renameat(parent, temp, parent, leaf) < 0) goto internal;
  }
  if (sync_parent(parent) < 0) { free(leaf); close(parent); return EXIT_DURABILITY; }
  puts(resulting_hash); free(leaf); close(parent); return 0;
internal:
  unlinkat(parent, temp, 0); free(leaf); close(parent); return EXIT_INTERNAL;
}

static int remove_file(const char *root_path, const char *relative_path, const char *expected) {
  int root = open_absolute_root(root_path, 0);
  if (root < 0) return EXIT_PATH;
  char *leaf = NULL; int parent = open_parent(root, relative_path, 0, &leaf); close(root);
  if (parent < 0) return EXIT_PATH;
  int target = -1; struct stat identity;
  int code = verify_open_target(parent, leaf, expected, &target, &identity);
  if (code != 0) { if (target >= 0) close(target); free(leaf); close(parent); return code; }
  if (test_pause_before_commit() < 0) code = EXIT_INTERNAL;
  else if (!identity_still_matches(parent, leaf, &identity)) code = EXIT_CONFLICT;
  else if (unlinkat(parent, leaf, 0) < 0) code = errno == ENOENT ? EXIT_CONFLICT : EXIT_INTERNAL;
  else if (sync_parent(parent) < 0) code = EXIT_DURABILITY;
  close(target); free(leaf); close(parent); return code;
}

static int backup_file(const char *source_root_path, const char *source_relative,
                       const char *destination_root_path, const char *destination_relative,
                       const char *expected) {
  int source_root = open_absolute_root(source_root_path, 0);
  if (source_root < 0) return EXIT_PATH;
  char *source_leaf = NULL, *destination_leaf = NULL;
  int source_parent = open_parent(source_root, source_relative, 0, &source_leaf);
  close(source_root);
  if (source_parent < 0) return EXIT_PATH;
  int source = -1, destination_parent = -1;
  struct stat identity;
  int code = verify_open_target(source_parent, source_leaf, expected, &source, &identity);
  if (code != 0) goto done;
  int destination_root = open_absolute_root(destination_root_path, 1);
  if (destination_root < 0) { code = EXIT_PATH; goto done; }
  destination_parent = open_parent(destination_root, destination_relative, 1, &destination_leaf);
  close(destination_root);
  if (destination_parent < 0) { code = EXIT_PATH; goto done; }
  char temp[80]; snprintf(temp, sizeof(temp), ".aich-%ld.tmp", (long)getpid());
  int output = openat(destination_parent, temp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (output < 0) { code = EXIT_INTERNAL; goto done; }
  if (lseek(source, 0, SEEK_SET) < 0) { code = EXIT_INTERNAL; close(output); unlinkat(destination_parent, temp, 0); goto done; }
  unsigned char buffer[65536];
  for (;;) {
    ssize_t count = read(source, buffer, sizeof(buffer));
    if (count < 0) { if (errno == EINTR) continue; code = EXIT_INTERNAL; break; }
    if (count == 0) break;
    size_t offset = 0;
    while (offset < (size_t)count) { ssize_t written = write(output, buffer + offset, (size_t)count - offset); if (written < 0) { if (errno == EINTR) continue; code = EXIT_INTERNAL; break; } offset += (size_t)written; }
    if (code != 0) break;
  }
  if (code == 0 && (fchmod(output, identity.st_mode & 0777) < 0 || fsync(output) < 0)) code = EXIT_INTERNAL;
  if (close(output) < 0 && code == 0) code = EXIT_INTERNAL;
  if (code == 0 && !identity_still_matches(source_parent, source_leaf, &identity)) code = EXIT_CONFLICT;
  if (code == 0 && renameat(destination_parent, temp, destination_parent, destination_leaf) < 0) code = EXIT_INTERNAL;
  if (code == 0 && sync_parent(destination_parent) < 0) code = EXIT_DURABILITY;
  if (code == 0) puts(expected);
  if (code != 0 && code != EXIT_DURABILITY) unlinkat(destination_parent, temp, 0);
done:
  if (source >= 0) close(source);
  if (source_parent >= 0) close(source_parent);
  if (destination_parent >= 0) close(destination_parent);
  free(source_leaf); free(destination_leaf); return code;
}

int main(int argc, char **argv) {
  if (argc == 5 && strcmp(argv[1], "replace") == 0) return replace_file(argv[2], argv[3], argv[4]);
  if (argc == 5 && strcmp(argv[1], "remove") == 0) return remove_file(argv[2], argv[3], argv[4]);
  if (argc == 7 && strcmp(argv[1], "backup") == 0) return backup_file(argv[2], argv[3], argv[4], argv[5], argv[6]);
  fprintf(stderr, "usage: deployment-file-helper replace|remove|backup ...\n");
  return EXIT_INTERNAL;
}
