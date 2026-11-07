function one() {
  return two();
}
function two() {
  return 2;
}
module.exports = {
  one,
  two,
  three() {
    return one();
  },
};
