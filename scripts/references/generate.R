# Reference outputs for the statistics engine's parity tests.
#
# Not run in CI and not needed at runtime: the JSON it writes is committed,
# and scripts/analysis.ts compares the TypeScript engine against it. Re-run
# only to regenerate the fixtures (R >= 4.3, lavaan 0.6-17, semTools 0.5-6):
#
#   Rscript scripts/references/generate.R
#
# Settings chosen to match the engine exactly:
#   likelihood = "wishart"  -> chi-square = (N-1) * F_ML, S with divisor N-1 (as AMOS)
#   information = "expected" -> standard errors from the expected information matrix
#   marker-variable identification (first loading fixed to 1), listwise deletion.

suppressPackageStartupMessages({ library(lavaan); library(semTools); library(jsonlite) })

out_data <- "evals/fixtures/datasets"
out_ref  <- "evals/fixtures/references"

versions <- list(R = R.version.string,
                 lavaan = as.character(packageVersion("lavaan")),
                 semTools = as.character(packageVersion("semTools")))

cfa_reference <- function(model, data, label) {
  fit <- cfa(model, data = data, estimator = "ML", likelihood = "wishart",
             information = "expected", missing = "listwise", std.lv = FALSE)
  pe <- parameterEstimates(fit, standardized = TRUE)
  ss <- standardizedSolution(fit)
  fm <- fitMeasures(fit, c("chisq", "df", "pvalue", "cfi", "tli", "rmsea", "srmr",
                           "baseline.chisq", "baseline.df", "ntotal"))
  loadings <- pe[pe$op == "=~", c("lhs", "rhs", "est", "se", "z", "std.all")]
  residuals <- pe[pe$op == "~~" & pe$lhs == pe$rhs & !(pe$lhs %in% unique(loadings$lhs)), c("lhs", "est", "se")]
  factorcov <- pe[pe$op == "~~" & pe$lhs %in% unique(loadings$lhs), c("lhs", "rhs", "est", "se")]
  corr <- ss[ss$op == "~~" & ss$lhs != ss$rhs & ss$lhs %in% unique(loadings$lhs), c("lhs", "rhs", "est.std", "se")]
  list(label = label, settings = list(estimator = "ML", likelihood = "wishart", information = "expected",
                                      identification = "marker", missing = "listwise"),
       versions = versions, n = unname(fm["ntotal"]),
       fit = as.list(fm),
       loadings = loadings, residuals = residuals, factorCovariances = factorcov,
       factorCorrelations = corr)
}

# 1. Holzinger & Swineford (1939), the canonical three-factor CFA -------------
hs <- HolzingerSwineford1939[, paste0("x", 1:9)]
write.csv(hs, file.path(out_data, "holzinger_swineford_1939.csv"), row.names = FALSE)
hs_model <- "visual =~ x1 + x2 + x3\n textual =~ x4 + x5 + x6\n speed =~ x7 + x8 + x9"
write_json(cfa_reference(hs_model, hs, "Holzinger-Swineford 1939, 3 factors, N = 301"),
           file.path(out_ref, "cfa-hs1939.json"), digits = NA, auto_unbox = TRUE, pretty = TRUE)

# 2. A simulated survey with blank cells --------------------------------------
# Three correlated constructs, five-point items, then 6% of rows lose one cell.
set.seed(20260923)
n <- 360
phi <- matrix(c(1, .45, .30, .45, 1, .50, .30, .50, 1), 3)
f <- MASS::mvrnorm(n, rep(0, 3), phi)
lam <- c(.80, .75, .70)
items <- list()
for (k in 1:3) for (j in 1:3) {
  latent <- lam[j] * f[, k] + sqrt(1 - lam[j]^2) * rnorm(n)
  items[[paste0(c("TR", "AT", "IN")[k], j)]] <- as.integer(cut(latent, c(-Inf, -1.2, -.4, .4, 1.2, Inf)))
}
sim <- as.data.frame(items)
holes <- sample(seq_len(n), round(.06 * n))
for (row in holes) sim[row, sample(ncol(sim), 1)] <- NA
write.csv(sim, file.path(out_data, "survey_with_blanks.csv"), row.names = FALSE, na = "")
sim_model <- "TRUST =~ TR1 + TR2 + TR3\n ATT =~ AT1 + AT2 + AT3\n INT =~ IN1 + IN2 + IN3"
sim_ref <- cfa_reference(sim_model, sim, "Simulated survey, 3 factors, 6% rows with one blank")

# HTMT on the complete cases (semTools::htmt: arithmetic mean, absolute correlations).
complete <- sim[complete.cases(sim), ]
h <- htmt(sim_model, data = complete, absolute = TRUE, htmt2 = FALSE)
sim_ref$htmt <- list(constructs = colnames(h), matrix = unclass(h))
sim_ref$completeCases <- nrow(complete)
sim_ref$blankRows <- length(holes)

# Composite-indicator VIF check: each TR item regressed on its two siblings.
vif <- sapply(c("TR1", "TR2", "TR3"), function(v) {
  others <- setdiff(c("TR1", "TR2", "TR3"), v)
  r2 <- summary(lm(reformulate(others, v), data = complete))$r.squared
  1 / (1 - r2)
})
sim_ref$vifTrust <- as.list(vif)
write_json(sim_ref, file.path(out_ref, "cfa-survey-blanks.json"), digits = NA, auto_unbox = TRUE, pretty = TRUE)

cat("references written\n")
